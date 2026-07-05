# 稳定后全量更新代码事实

当前代码把 FC/FS enrichment 从“消歧 + 触发局部 update_score”的职责里拆出来，只让它做最近 FC/FS 补充；另建一条“用户停止游玩一段时间后执行全量 `update_score`”的收尾链路。

## 背景

历史逻辑里 recent event 水位线和 ambiguous fallback 曾经混在一起：

- 曾用 `recentEventSince` 过滤两次 enrichment 之间的 recent event。
- 如果 recent event 的 `songName + difficulty` 在当前成绩里命中多个 musicId，曾创建 `diffsToScrape` 的 `update_score` fallback。
- 为了避免 fallback 被同一批 recent event 反复触发，水位线曾承担“去重 / 防重复触发”的作用。

当前代码已移除这层耦合：

- FC/FS enrichment 不再创建 fallback `update_score`。
- FC/FS enrichment 不再依赖 `recentEventSince` 过滤窗口。
- recent event 只作为“能补则补”的增量 FC/FS 来源。
- 全量 `update_score` 由新的稳定后 debounce 机制负责。

## 边界

- 不在 FC/FS enrichment 中解决重名曲目的 musicId 消歧。
- 不让 FC/FS enrichment 触发指定难度 fallback。
- 不按 hot 用户定时全量抓分。
- 不替代 rival score probe；rival 仍是 achievement / dxScore 的主更新链路。

## FC/FS Enrichment 新语义

执行 `get_user_recent_event` 后：

1. 解析 recent event 中的 FC/AP/FS/FDX。
2. 对每条 event 使用 `songName + difficulty` 找曲库候选。
3. 只在当前 sync 中唯一命中一个 `(musicId, chartIndex)` 时合并 FC/FS。
4. 如果当前 sync 中命中 0 个或多个 score，跳过该 event。
5. 不返回 ambiguous difficulty。
6. 不创建 fallback `update_score`。

合并仍保持 rank-only：

```text
FC: null < fc < fcp < ap < app
FS: null < fs < fsp < fdx < fdxp
```

已删除内容：

- 删除 `recentEventSince` 过滤。
- 删除之前为 DXNet 延迟可见加的 lookback 包容逻辑。
- 删除 `scheduleAmbiguousFcfsFallback()` 及相关 job context。
- 删除 recent-event ambiguous fallback 文档和测试。

保留内容：

- FC/FS enrichment per-user cooldown。
- cooldown 内 pending FC/FS enrichment 合并，到期补跑一次。
- `addRival + get_user_recent_event` 执行方式。
- `get_user_recent_event` job 默认延迟 3 分钟执行，等待 DXNet recent event 页面稳定。

## 稳定后全量更新

当前有一条 state-level debounce 机制：只要检测到用户可能还在玩，就把全量 `update_score` 预约到“最近一次活动信号后 45 分钟”。

### 活动信号

以下任一事件都表示用户成绩或游玩状态可能发生变化：

1. Rival score probe 检测到 `rival hash changed`。
2. Map auxiliary probe 检测到 `map fingerprint changed`。
3. FC/FS enrichment 检测到 recent event 列表发生变化。

第 3 点不能依赖 `recentEventSince`。保存 recent event 的轻量 fingerprint：

```text
recentEventFingerprint = sha256(
  sorted/events-in-page-order of:
  time | songName | difficulty | fc | fs
)
```

当本次 fingerprint 与 `lastRecentEventFingerprint` 不同时：

- 更新 `lastRecentEventFingerprint`。
- 视为活动信号。
- 合并能唯一定位的 FC/FS。

如果 recent event 页面为空，也应把 fingerprint 记为稳定值，避免反复把空结果当变化。

### Debounce 行为

配置：

```text
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

命中后创建 DXNet job：

```ts
JobService.create({
  friendCode,
  jobType: "update_score",
  diffsToScrape: null,
  cancelActiveJobs: false,
  removeFriendAfterComplete: true,
  context: {
    source: "auto_update_settled_full_update",
    lastActivityAt,
  },
});
```

`diffsToScrape: null` 走 worker 默认全难度：

```text
0 basic
1 advanced
2 expert
3 master
4 remaster
10 utage
```

代码沿用 worker 现有默认范围，包含 utage。

成功创建 job 后清理 pending：

```text
pendingFullUpdateAt = null
```

如果创建失败：

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
- 不再创建第二个 full update。
- 直接清理 pending full update，认为已有 active `update_score` 已经覆盖本次“稳定后全量更新”需求。

原因：active job 可能是手动同步，也可能是上一次自动 full update。无论来源如何，它都会抓全量成绩并写最新 sync；自动更新不应打断手动同步，也不需要再排一个重复 full update。

## 数据模型

`auto_update_probe_states` 字段：

| 字段                         | 含义                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `lastAutoUpdateActivityAt`   | 最近一次通过 rival/map/recent event 观测到活动信号的时间  |
| `pendingFullUpdateAt`        | 稳定后全量 `update_score` 的预约执行时间                  |
| `lastRecentEventFingerprint` | 最近一次 FC/FS enrichment 返回的 recent event fingerprint |

索引：

```text
{ enabled: 1, pendingFullUpdateAt: 1 }
```

## 代码入口

### SyncService

- `mergeRecentEvents()` 不接收 `since`。
- 不存在 `filterRecentEventsSince()`。
- 不存在 recent event lookback 常量。
- 遇到 `matches.length !== 1` 时直接跳过。
- 返回值不包含 `ambiguousDiffs`。

### JobService

- `handleCompletedRecentEvent()` 不解析 `context.recentEventSince`。
- 不存在 `scheduleAmbiguousFcfsFallback()`。
- recent event 完成后：
  - 合并 FC/FS。
  - 计算 recent event fingerprint。
  - 如果 fingerprint 变化，通知 auto-update scheduler 预约 settled full update。

实现使用 `AutoUpdateActivityService`，把 activity scheduling 抽成独立 service，避免 `JobService` 直接依赖整个 scheduler。该 service 提供：

```ts
recordActivitySignal({
  friendCode,
  at,
});

recordRecentEventFingerprint({
  friendCode,
  fingerprint,
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

- `SyncService.createFromJob()` 写最新 sync。
- `ProberExportService.enqueueAutoExportForSync({ trigger: 'dxnet_update_score' })` 自动导出。

不新增导出 trigger。全量收尾仍沿用 `dxnet_update_score`；如需排查来源，看 DXNet job context 的 `source: "auto_update_settled_full_update"`。

## 失败与退避

- Rival / map 失败沿用现有 backoff。
- FC/FS enrichment 失败沿用 `nextRecentEventAt` retry，并保留 pending FC/FS enrichment。
- Settled full update 创建失败使用独立短 retry，不应阻塞 rival/map 主探测。
- Full update job 自身失败后，不自动无限重试；下一次 activity signal 会重新预约。
- Continuous play 不设置强制最大延迟上限；只要 activity signal 持续出现，就持续延后，始终等待 quiet window。

## 部署兼容

旧 `auto_update_probe_states` 文档缺少新增字段时等价于 null。代码部署后，新的 activity signal 会开始写 `pendingFullUpdateAt`，recent event fingerprint 会写入 `lastRecentEventFingerprint`。

## 已确认决策

1. `AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS` 固定为 45 分钟，不按 tier 变化。
2. Full update 使用 worker 默认难度范围 `[0,1,2,3,4,10]`，包含 utage。
3. Continuous play 不设置最大延迟上限，始终等待 quiet window。
4. Due 时已有 active `update_score` 则直接清 pending，认为该 job 已覆盖本次收尾。
5. 不新增导出 trigger，沿用 `dxnet_update_score`。
