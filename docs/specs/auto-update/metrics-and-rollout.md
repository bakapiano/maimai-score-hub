# 指标与上线计划

本方案按 **breaking change** 设计：上线目标是直接切到 Rival-first 自动更新模型，然后通过限流和调度参数控制风险。

## 核心指标

| 指标                                  | 用途                               |
| ------------------------------------- | ---------------------------------- |
| `rival_probe_count`                   | `GetUserRivalMusicApi` 调用量      |
| `rival_probe_latency_ms`              | RivalMusic 延迟                    |
| `rival_probe_payload_bytes`           | RivalMusic payload 大小            |
| `rival_probe_error_count`             | RivalMusic 错误率                  |
| `rival_hash_changed_count`            | 成绩 hash 变化次数                 |
| `rival_score_merge_count`             | RivalMusic list 与当前成绩合并次数 |
| `map_probe_count`                     | `GetUserMapApi` 辅助调用量         |
| `map_probe_latency_ms`                | Map API 延迟                       |
| `map_probe_payload_bytes`             | Map payload 大小                   |
| `map_delta_count`                     | 探测到 score-silent 活跃的次数     |
| `map_delta_with_rival_hash_unchanged` | map 变化但 rival hash 未变的比例   |
| `recent_event_job_count`              | FC/FS 补全压力                     |
| `recent_event_hit_count`              | recent event 命中 FC/FS 的比例     |
| `recent_event_merge_count`            | FC/FS list 与当前成绩合并次数      |
| `queue_lag_seconds`                   | 各队列排队延迟                     |
| `tier_user_count`                     | hot / warm / cold 用户分布         |
| `scheduler_due_count`                 | 每轮到期用户数                     |
| `rate_limit_deferred_count`           | 目标指标；当前 Phase 1 未实现      |

## 关键评估问题

1. `GetUserRivalMusicApi` 在队列并发和长期运行下 p95 是否稳定。
2. 8 qps rival probe 是否足以覆盖 10k 主峰，队列 lag 是否可接受。
3. RivalMusic list 直接合并当前成绩后，成绩写入量、Mongo 压力是否稳定。
4. Map auxiliary 能发现多少 score-silent 活跃。
5. Recent event 对 FC/FS 的命中率是否足够高。
6. 2 个 Bot 下 30/min recent event 是否会触发 DXNet 567 / 空响应。

## 上线阶段

### Phase 0: 压测与迁移准备

- 对 `GetUserRivalMusicApi` 做 sustained load test：8 qps / 10 qps / 12 qps，各跑 30-60 分钟。
- 对 `GetUserMapApi` 做辅助压测：2-3 qps，确认 p95 和错误率。
- 对 recent event 做 2 Bot 压测：30/min 起步，观察 DXNet 567 / 空响应。
- 建立新状态表和任务表。
- 初始化 `auto_update_probe_states`：
  - 已开启自动更新且绑定 cabinet userId 的用户进入新状态表。
  - 初始 tier 可全部设为 `cold`，或按最近 score-active 时间粗略初始化为 hot / warm / cold。
  - `habitMultiplier=1`，`schedulerVersion` 写入当前策略版本。

### Phase 1: Breaking cutover

- 新 scheduler 成为唯一自动更新任务生产者。
- Rival score probe 开始写入成绩。
- Map auxiliary probe 开始运行，用于识别 score-silent 活跃。
- FC/FS enrichment 开始运行并写入；写入规则是本次 recent event list 直接与当前成绩按 rank 合并。
- Phase 1 已实现的执行控制：

```text
AUTO_UPDATE_RIVAL_BATCH_LIMIT = 480
AUTO_UPDATE_RIVAL_CONCURRENCY = 4
AUTO_UPDATE_MAP_BATCH_LIMIT = 120
AUTO_UPDATE_MAP_CONCURRENCY = 2
AUTO_UPDATE_RECENT_EVENT_COOLDOWN_MS = 30min
AUTO_UPDATE_RECENT_EVENT_DELAY_MS = 3min
AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS = 45min
AUTO_UPDATE_SETTLED_FULL_UPDATE_RETRY_MS = 10min
```

- 观察 24 小时后，如果错误率和 queue lag 稳定，可调整 backend batch / concurrency 和 sdgb-worker token bucket：

```text
target rival probe = 8 qps sustained / 10-12 qps burst
target map auxiliary = 2-3 qps
target recent event = 30/min
```

### Phase 2: 用户习惯调度

- 引入用户游玩习惯画像，只影响下一次探测时间：

```text
base tier interval
  * habitMultiplier
  * loadMultiplier
  -> nextRivalProbeAt / nextMapProbeAt
```

- 画像输入只来自已观测到的 rival hash change / map distance change。
- Phase 2 先只使用小时偏好；星期偏好可记录但默认不参与倍率。
- 节假日偏好不进入 Phase 2，避免过拟合和额外日历依赖。

建议 Phase 2 multiplier：

| 条件                     |  habitMultiplier |
| ------------------------ | ---------------: |
| 样本不足 / confidence 低 |              1.0 |
| 当前小时是用户高频小时   |          0.5-0.7 |
| 当前小时是用户低频小时   |          1.2-1.5 |
| 用户 7 天无活跃          | 1.0，继续按 cold |

### Phase 3: 参数收敛

- 根据 7-14 天数据复盘 tier 分布、queue lag、错误率、recent event 命中率。
- 调整 hot / warm / cold interval。
- 调整 rival probe sustained / burst 上限。
- 决定是否扩大 Map auxiliary 覆盖面，或只保留在 hot score-silent 场景。

## SLO 建议

| 项                         | 目标                      |
| -------------------------- | ------------------------- |
| hot 用户 rival probe 间隔  | p95 <= 10 min + queue lag |
| warm 用户 rival probe 间隔 | p95 <= 30 min + queue lag |
| cold 用户 rival probe 间隔 | p95 <= 60 min + queue lag |
| rival score merge 延迟     | p95 < 15 min              |
| FC/FS enrichment 延迟      | p95 < 60 min              |
| rival probe 错误率         | < 2%                      |
| map auxiliary 错误率       | < 1%                      |
| recent event 错误率        | < 5%                      |
