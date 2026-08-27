# 稳定后全量更新代码事实

当前代码包含两条互补链路：半小时变化谱面的定向 FC/FS 补全，以及“用户停止游玩一段时间后执行全量 `update_score`”的收尾链路。

## 背景

RivalMusic 能直接更新 achievement 与 DX Score，页面结果缺少 FC/FS。Scheduler
因此每半小时聚合一次 `score_changes`：只选择 `changedFields` 含 `score` 或
`dxScore` 的记录，并把 `(musicId, chartIndex)` 转成谱面 CID。

## 边界

- Rival 继续负责 achievement / DX Score 主更新。
- 定向 FC/FS 结果通过谱面 CID 映射，避免标题消歧。
- 稳定后 full update 继续负责全谱面 FC/FS 收尾；achievement 与 DX Score 以
  Rival 更新结果为准。

## 定向 FC/FS 语义

每个用户在窗口内变化的 CID 合并到 `pendingFcfsMusicIds`。单用户 cooldown
到期且 producer 配额可用时，创建：

```ts
JobService.create({
  jobType: "update_score",
  source: "auto_update",
  musicIds: pendingFcfsMusicIds,
  fcfsOnly: true,
  context: { source: "auto_update_fcfs_score_window", autoUpdateFcfs: true },
});
```

Worker 根据 CID 元数据选择最小扫描量的具体 genre/level 页面组合，只请求
`scoreType=2`，并返回 `{ musicId: cid, fc, fs }`。Backend 通过 CID 直接定位
current score，保留 achievement、DX Score 与 rating，只升级 FC/FS rank。

合并仍保持 rank-only：

```text
FC: null < fc < fcp < ap < app
FS: null < fs < fsp < fdx < fdxp
```

执行控制沿用原链路水位：单用户 30 分钟 cooldown、全局 base 8 jobs/min、
burst 2。Job 使用 background lane、priority 1。

`fcfs_enrichment` task 在 DXNet job 创建后保持 `processing` 并记录 job id。
只有 job 进入 `completed` 才更新 `lastFcfsUpdateAt` 并完成 task；job
`failed/canceled` 时，原 musicIds 合并回 `pendingFcfsMusicIds`，按照 FC/FS
backoff 重新预约。Backend 重启造成的未完成 dispatch claim 在 5 分钟后自动恢复。

每个窗口由 `auto-update-sweep` 外层 lease、
`fcfs-score-window-trigger:<windowEnd>` 日志 lease，以及唯一
`auto_update_runs.bucketKey=fcfs-score-window:<windowEnd>` 三层 fence 保证多实例只
stage 一次。用户级 pending 使用 `$addToSet` 合并 CID，producer 配额在 Redis 全局计数。

## 稳定后全量更新

当前有一条 state-level debounce 机制：只要检测到用户可能还在玩，就把全量 `update_score` 预约到“最近一次活动信号后 45 分钟”。

### 活动信号

以下事件表示用户成绩或游玩状态可能发生变化：

1. Rival score probe 检测到 `rival hash changed`。
2. Map auxiliary probe 检测到 `map fingerprint changed`。

### Debounce 行为

配置：

```text
AUTO_UPDATE_SETTLED_FULL_UPDATE_BATCH_LIMIT = 12
AUTO_UPDATE_SETTLED_FULL_UPDATE_MAX_ACTIVE = 12
AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS = 45min
AUTO_UPDATE_SETTLED_FULL_UPDATE_RETRY_MS = 10min
```

每次收到活动信号：

```text
pendingFullUpdateAt = now + AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS
lastAutoUpdateActivityAt = now
```

如果 0min、15min、30min 都有活动信号：

```text
0min  signal -> pendingFullUpdateAt = 45min
15min signal -> pendingFullUpdateAt = 60min
30min signal -> pendingFullUpdateAt = 75min
45min no signal
75min due -> create full update_score
```

这就是“用户稳定后再全量抓一次”的核心语义。

### 触发全量 update_score

scheduler 每轮额外扫描：

```text
enabled = true
pendingFullUpdateAt <= now
backoffUntil is null or <= now
```

每轮先统计 `context.source=auto_update_settled_full_update` 且状态为
`queued/processing` 的活跃任务，再按 `pendingFullUpdateAt` 从旧到新补足水位：

```text
dispatchLimit = min(batchLimit, maxActive - active)
```

默认 batch/max-active 都是 12。这个上限与 Map auxiliary 的 batch 独立；
剩余 state 保留到后续 sweep。自动全量任务使用 priority 1，低于手动
`update_score` 的 priority 2 和好友/登录任务的 priority 3。

命中后创建 DXNet job：

```ts
JobService.create({
  friendCode,
  jobType: "update_score",
  diffsToScrape: [0, 1, 2, 3, 4, 10],
  fcfsOnly: true,
  cancelActiveJobs: false,
  removeFriendAfterComplete: true,
  context: {
    source: "auto_update_settled_full_update",
    lastActivityAt,
  },
});
```

显式全难度范围为：

```text
0 basic
1 advanced
2 expert
3 master
4 remaster
10 utage
```

任务仅请求 `scoreType=2` 并合并 FC/FS，保留 Rival 已写入的 achievement、
DX Score 与 rating；范围包含 utage。

成功创建 job 后按原 `pendingFullUpdateAt` 条件清理 pending，并创建
`settled_full_update` processing task 跟踪 job 终态：

```text
pendingFullUpdateAt = null
```

如果创建失败，或已创建 job 最终 `failed/canceled`：

```text
pendingFullUpdateAt = now + AUTO_UPDATE_SETTLED_FULL_UPDATE_RETRY_MS
```

### 活动期间重复触发

如果 pending full update 尚未到期，又收到新的 activity signal，只更新同一条 state：

- 不创建多个 update_score job。
- 不写 `auto_update_tasks` 队列行作为真正队列。
- 最终只执行一次最新的 full update。

### 与已有 update_score 的关系

due 时如果用户已有 active `update_score`：

- 不取消已有任务。
- active job 是全量更新时，跟踪其终态并复用结果。
- active job 是 targeted 更新时，保留 pending 并延后本轮 dispatch。

全量 job 完成后 task 才进入 `completed`；失败时恢复
`pendingFullUpdateAt`。新 activity signal 写入了更新预约时间时，旧 job 的成功
reconciliation 保留该新预约。

## 每日收尾全量更新

稳定后 debounce 之外，scheduler 每日北京时间 02:00 为前一 UTC+8 自然日建立一次
`daily_full_update` 批次。业务日期 `D` 的统计窗口固定为：

```text
[D 00:00:00 Asia/Shanghai, D+1 00:00:00 Asia/Shanghai)
```

候选集来自该窗口内 `score_changes.observedAt` 的 distinct `friendCode`，随后与
`auto_update_probe_states.enabled=true` 相交，因此任务覆盖仍开启自动更新并已绑定
cabinet userId 的实际变化用户。

### 多实例唯一触发

每日批次使用三层 fence：

1. 外层 `auto-update-sweep` Redis lease 选出本轮 scheduler owner。
2. `auto-update-daily-full-update-trigger:<businessDate>` Redis lease 选出该业务日的 trigger owner。
3. `auto_update_runs.bucketKey=daily-full-update:<businessDate>` 唯一索引保存一次性完成标记。

trigger owner 以确定性 id
`daily-full-update:<businessDate>:<friendCode>` upsert staging task。进程在 staging 中途退出时，
下一位 lease owner 会从 `status=running` 的日记录恢复；确定性 task id 保证重复 staging 收敛
到同一行。日记录的 `completed` 表示候选 staging 已完成，具体 DXNet job 终态由 task 跟踪。

### 分批投递和恢复

默认参数：

```text
AUTO_UPDATE_DAILY_FULL_UPDATE_HOUR = 2
AUTO_UPDATE_DAILY_FULL_UPDATE_BATCH_LIMIT = 4
AUTO_UPDATE_DAILY_FULL_UPDATE_MAX_ACTIVE = 8
AUTO_UPDATE_DAILY_FULL_UPDATE_RETRY_MS = 10min
AUTO_UPDATE_DAILY_FULL_UPDATE_MAX_ATTEMPTS = 3
AUTO_UPDATE_DAILY_FULL_UPDATE_CLAIM_TIMEOUT_MS = 5min
```

每轮 scheduler 先统计所有来源中处于 `queued/processing` 的 `update_score`：

```text
dispatchLimit = min(batchLimit, maxActive - activeUpdateScores)
```

Mongo staging task 按 `runAt/createdAt` 从旧到新原子 claim，随后创建
`context.source=auto_update_daily_full_update` 的 background 全量 job。已有同用户 active
`update_score` 时，task 绑定该 job 并跟踪其终态。Job 完成后 task 进入 `completed`；Job
失败、取消或 stale claim 恢复后按 10 分钟退避重新排队，达到 3 次尝试后进入 `failed`。

每日全量 job 同样传入 `fcfsOnly=true`：Rival 已负责 achievement 与 DX Score，
每日收尾只补齐所有难度的 FC/FS。

## 数据模型

`auto_update_probe_states` 字段：

| 字段                       | 含义                                        |
| -------------------------- | ------------------------------------------- |
| `lastAutoUpdateActivityAt` | 最近一次通过 rival/map 观测到活动信号的时间 |
| `pendingFullUpdateAt`      | 稳定后全量 `update_score` 的预约执行时间    |

索引：

```text
{ enabled: 1, pendingFullUpdateAt: 1 }
```

## 代码入口

### SyncService

- `createFromJob()` 识别 `targetedScores` 并按 CID 映射。
- `context.autoUpdateFcfs=true` 记录 `sourceType=auto_update_fcfs`。
- FC/FS-only delta 通过统一 CAS 与 rank merge 写入 current。

### JobService

- `musicIds` 解析为 `scoreFetchTargets` 后持久化到 Job。
- `fcfsOnly` 独立持久化并透传 Worker。
- 所有 `update_score` 都使用 commit-first finalization。

`AutoUpdateActivityService` 继续负责 settled activity scheduling：

```ts
recordActivitySignal({
  friendCode,
  at,
});
```

### AutoUpdateSchedulerService

- rival hash changed 后调用 `recordActivitySignal()`。
- map fingerprint changed 后调用 `recordActivitySignal()`。
- 每轮 sweep 扫描 due `pendingFullUpdateAt`。
- due 后创建 full `update_score` job。

## 任务与导出

全量 `update_score` 完成后沿用现有逻辑：

- `SyncService.createFromJob()` 通过统一 CAS 把 delta 合并进 current sync。
- score version 实际增加后 best-effort 唤醒稳定的 per-user export delivery。
- `prober_export_states` 与 `syncs.__v` 的定期 reconciliation 是漏投恢复来源。

不为 settled full update 新增来源级导出 trigger；实际 auto attempt 只记录 requested/exported
score version。如需排查成绩来源，看 DXNet job context 的
`source: "auto_update_settled_full_update"`。导出状态机见
[Prober Export 规范](../prober-export/README.md)。

## 失败与退避

- Rival / map 失败沿用现有 backoff。
- FC/FS job 创建或执行失败沿用 `nextFcfsUpdateAt` retry，并把原 musicIds 合并回 `pendingFcfsMusicIds`。
- Settled full update 创建或执行失败使用独立短 retry，并恢复 `pendingFullUpdateAt`。
- reconciliation 通过 task job id 和 job context 双路径恢复，Backend 重启不会丢失终态。
- Continuous play 不设置强制最大延迟上限；只要 activity signal 持续出现，就持续延后，始终等待 quiet window。

## 部署兼容

旧 `auto_update_probe_states` 文档缺少新增 FC/FS 字段时使用 schema 默认值；
新窗口会开始写 `pendingFcfsMusicIds/nextFcfsUpdateAt`。

## 已确认决策

1. `AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS` 固定为 45 分钟，不按 tier 变化。
2. 自动 Full update 使用 `[0,1,2,3,4,10] + fcfsOnly=true`，包含 utage，并保留
   Rival 写入的 achievement、DX Score 与 rating。
3. Continuous play 不设置最大延迟上限，始终等待 quiet window。
4. Due 时只有 active 全量 `update_score` 能覆盖本次收尾，并持续跟踪到终态。
5. 不创建来源级导出 trigger；score version 增加后走统一 per-user wake 与版本 reconciliation。
6. Settled full update 使用独立的 12 个 batch/active 水位，不再复用 Map batch。
7. 自动 full update 使用 priority 1；手动 update_score 保持 priority 2。
