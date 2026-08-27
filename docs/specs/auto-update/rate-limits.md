# 执行控制与限流现状

自动更新需要同时保护 sdgb-worker、DXNet worker、Bot cookie 和上游服务。Rival-first 后，`GetUserRivalMusicApi` 是主负载，`GetUserMapApi` 是辅助负载。

## Phase 1 已实现的执行控制

| 链路                | 当前代码控制                                                               | 说明                                                                                              |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rival score probe   | `AUTO_UPDATE_RIVAL_BATCH_LIMIT=480`，`AUTO_UPDATE_RIVAL_CONCURRENCY=4`     | 每轮最多处理 480 个 due state，scheduler 同时等待 4 个 sdgb job                                   |
| Map auxiliary       | `AUTO_UPDATE_MAP_BATCH_LIMIT=120`，`AUTO_UPDATE_MAP_CONCURRENCY=2`         | 每轮最多处理 120 个 due state                                                                     |
| Targeted FC/FS      | 独立 drain + Redis leaky bucket，base/burst=`8/min, 2`                     | 按健康 Bot 数量动态降速，单 job 最多 32 个 CID                                                    |
| Settled full update | `AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS=45min`，batch/max-active=`12/12` | 活动信号 debounce 后创建 priority=1 的全量 DXNet `update_score`；每轮只补足空闲水位               |
| Daily full update   | 北京时间 02:00，batch/max-active=`4/8`                                     | 前一 UTC+8 自然日有成绩变化的用户先写 Mongo staging task，再按全局 active `update_score` 水位投递 |
| Rival / map 失败    | 指数退避 / map 线性退避                                                    | 避免失败用户持续消耗资源                                                                          |
| sdgb worker         | BullMQ consumer，`SDGB_WORKER_CONCURRENCY=16`                              | 已实现 global + per-API token bucket，并支持按 job type 并发上限                                  |

## 10k 目标 QPS

以下是目标容量，不是当前代码硬限制：

| API 类型                          |                                 目标 |
| --------------------------------- | -----------------------------------: |
| `GetUserRivalMusicApi`            |     8 qps sustained，10-12 qps burst |
| `GetUserMapApi`                   |                              2-3 qps |
| `UserFriendRegistApi` / add rival |                          0.2-0.5 qps |
| targeted FC/FS update             | base 8 jobs/min，按健康 Bot 动态降速 |

sdgb-worker 已改为 BullMQ consumer，不再调用 `/workers/sdgb/jobs/next` 拉取。实际 QPS 由 worker 内 token bucket 控制。

## DXNet 定向 FC/FS 限流

当前代码配置：

```text
targeted_fcfs_base_rate = 8 jobs/min
targeted_fcfs_burst = 2
targeted_fcfs_per_user_cooldown = 30min
AUTO_UPDATE_TARGETED_FCFS_ENABLED = false  # rollout default
```

半小时窗口只聚合 `score_changes`，独立 drain 每 5 秒竞争一次 Redis lease。
全局 leaky bucket 将 8 jobs/min 换算成 7.5 秒一个名额，并允许 2 个初始
burst。安全速率按健康 Bot 数动态计算：

```text
rate = min(8, floor((healthyBots * 24 * 0.8 - 12) / 7.8))
4 / 3 / 2 / 1 Bot -> 8 / 5 / 3 / 0 jobs/min
```

每个 job 最多取 32 个 pending CID；仍有 CID 时 5 分钟后继续下一块。

每个半小时窗口聚合 `score_changes.changedFields` 中的 `score/dxScore`：

```text
score/dxScore changed -> chart CID list
cooldown or producer quota active -> merge into pendingFcfsMusicIds
due + quota available -> update_score(musicIds, fcfsOnly=true)
```

## 优先级现状

定向 FC/FS 使用 `source=auto_update` 的 `update_score`，进入 background lane、
priority 1。手动同步使用 user_sync lane、priority 2；登录/绑定使用 interactive
lane、priority 3–4。Mongo `auto_update_tasks.priority` 只记录 scheduler 审计值。

## 失败退避

当前 Phase 1 失败记录：

| 任务                                   | 初始退避 |     上限 |
| -------------------------------------- | -------: | -------: |
| rival score probe                      |   15 min |  4 hours |
| map auxiliary probe                    |    5 min |   1 hour |
| Targeted FC/FS job 创建或执行失败      |   30 min |  6 hours |
| Settled full update job 创建或执行失败 |   10 min |   10 min |
| Daily full update job                  |   10 min | 3 次尝试 |
