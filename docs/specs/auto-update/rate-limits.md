# 执行控制与限流现状

自动更新需要同时保护 sdgb-worker、DXNet worker、Bot cookie 和上游服务。Rival-first 后，`GetUserRivalMusicApi` 是主负载，`GetUserMapApi` 是辅助负载。

## Phase 1 已实现的执行控制

| 链路                | 当前代码控制                                                           | 说明                                                                                   |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Rival score probe   | `AUTO_UPDATE_RIVAL_BATCH_LIMIT=480`，`AUTO_UPDATE_RIVAL_CONCURRENCY=4` | 每轮最多处理 480 个 due state，scheduler 同时等待 4 个 sdgb job                        |
| Map auxiliary       | `AUTO_UPDATE_MAP_BATCH_LIMIT=120`，`AUTO_UPDATE_MAP_CONCURRENCY=2`     | 每轮最多处理 120 个 due state                                                          |
| Recent event        | `AUTO_UPDATE_RECENT_EVENT_COOLDOWN_MS=30min`                           | 单用户 cooldown；cooldown 内合并为 pending，到期生成 DXNet `get_user_recent_event` job |
| Recent event delay  | `AUTO_UPDATE_RECENT_EVENT_DELAY_MS=3min`                               | 创建 DXNet recent-event job 后延迟执行，等待 DXNet recent event 页面稳定               |
| Settled full update | `AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS=45min`                       | 活动信号 debounce 后创建一次全量 DXNet `update_score`                                  |
| Rival / map 失败    | 指数退避 / map 线性退避                                                | 避免失败用户持续消耗资源                                                               |
| sdgb worker         | BullMQ consumer，`SDGB_WORKER_CONCURRENCY=16`                          | 已实现 global + per-API token bucket，并支持按 job type 并发上限                       |

## 10k 目标 QPS

以下是目标容量，不是当前代码硬限制：

| API 类型                          |                             目标 |
| --------------------------------- | -------------------------------: |
| `GetUserRivalMusicApi`            | 8 qps sustained，10-12 qps burst |
| `GetUserMapApi`                   |                          2-3 qps |
| `UserFriendRegistApi` / add rival |                      0.2-0.5 qps |
| recent event                      |             2 bot 总 30/min 起步 |

sdgb-worker 已改为 BullMQ consumer，不再调用 `/workers/sdgb/jobs/next` 拉取。实际 QPS 由 worker 内 token bucket 控制。

## DXNet recent event 目标

按 2 个 Bot 估算：

| 策略       | 每 Bot | 2 Bot 总量 |
| ---------- | -----: | ---------: |
| 保守起步   | 12/min |     24/min |
| 推荐默认   | 15/min |     30/min |
| 观察后上调 | 18/min |     36/min |
| 不建议常态 | 24/min |     48/min |

目标配置：

```text
get_recent_event_global_limit = 30/min
get_recent_event_per_bot_limit = 15/min
get_recent_event_per_user_cooldown = 30min
get_recent_event_execution_delay = 3min
```

Phase 1 代码已实现 per-user cooldown；cooldown 内不会丢弃 rival/map 触发信号，而是记录 pending FC/FS enrichment 并在 `nextRecentEventAt` 到期后补跑一次。DXNet recent event 的 global/per-bot token bucket 尚未实现，当前主要依赖 worker/Bot 自身队列和 `get_user_recent_event` job 调度。

Recent event 只由变化事件触发：

```text
rival hash changed -> request fcfs_enrichment
map fingerprint changed -> request fcfs_enrichment
cooldown not due -> coalesce as pending fcfs_enrichment
cooldown due -> enqueue DXNet get_user_recent_event job
```

不要按 hot 用户定时全量扫 recent event；hot 只提高触发这些变化事件的概率。

手动/管理员强制触发 FC/FS enrichment 当前尚未实现。

如果 recent event 出现曲名歧义，FC/FS enrichment 直接跳过该条 event，不再创建指定难度 fallback。稳定后全量 `update_score` 由 activity debounce 统一负责。

## 优先级现状

当前代码没有实现跨链路的统一业务优先级调度：

- `auto_update_tasks.priority` 会记录优先级，但当前任务创建即 processing，不作为队列排序使用。
- `sdgb_jobs` 由 BullMQ 投递；sdgb-worker 按 job type 分 token bucket 和并发，但 BullMQ 队列本身还没有按 scan QR / rival / map / add rival 设优先级。
- DXNet `get_user_recent_event` 走现有 `JobService.create()` 和 worker 队列，优先级来自 job type priority。

目标上仍应保证登录、绑定、手动同步优先于自动更新；这需要后续在 backend enqueue 时设置 BullMQ priority 或拆独立队列。

## 失败退避

当前 Phase 1 失败记录：

| 任务                                                     | 初始退避 |    上限 |
| -------------------------------------------------------- | -------: | ------: |
| rival score probe                                        |   15 min | 4 hours |
| map auxiliary probe                                      |    5 min |  1 hour |
| FC/FS enrichment（含 add rival / 创建 recent event job） |   30 min | 6 hours |
