# 数据模型设计

目标是用明确的状态表表达自动更新状态，不再把 rival probe、map auxiliary、FC/FS enrichment 都隐含在同一种 job 里。

## `auto_update_probe_states`

一人一行。

| 字段                            | 含义                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `friendCode`                    | 用户好友码                                                 |
| `cabinetUserId`                 | 机台用户 ID                                                |
| `enabled`                       | 当前是否仍开启自动更新                                     |
| `tier`                          | `hot` / `warm` / `cold`                                    |
| `lastRivalHash`                 | 最近一次成功写入成绩对应的 rival hash                      |
| `lastRivalProbeAt`              | 最近一次 rival score probe 时间                            |
| `nextRivalProbeAt`              | 下一次允许 rival score probe 的时间                        |
| `lastScoreChangedAt`            | 最近一次 rival hash 变化时间                               |
| `mapFingerprint`                | 最近一次 `GetUserMapApi` 计算出的 fingerprint              |
| `mapDistanceSum`                | 可选，所有 map distance 聚合值                             |
| `lastMapProbeAt`                | 最近一次 map auxiliary 时间                                |
| `lastMapDeltaAt`                | 最近一次 map 变化时间                                      |
| `nextMapProbeAt`                | 下一次允许 map auxiliary 的时间                            |
| `lastRecentEventAt`             | 最近一次 FC/FS recent event 补全时间                       |
| `nextRecentEventAt`             | 下一次允许 recent event 的时间                             |
| `lastAutoUpdateActivityAt`      | 最近一次通过 rival/map/recent event 观测到活动信号的时间   |
| `pendingFullUpdateAt`           | 稳定后全量 `update_score` 的预约执行时间                   |
| `lastRecentEventFingerprint`    | 最近一次 FC/FS enrichment 返回的 recent event fingerprint  |
| `pendingRecentEventReason`      | cooldown / retry 期间挂起的一次 FC/FS enrichment 原因      |
| `pendingRecentEventRequestedAt` | 最近一次 pending FC/FS enrichment 触发时间                 |
| `pendingRecentEventCount`       | cooldown 期间合并过的 FC/FS enrichment 触发次数            |
| `rivalErrorCount`               | rival score probe 连续错误数                               |
| `mapErrorCount`                 | map auxiliary 连续错误数                                   |
| `recentErrorCount`              | recent event 连续错误数                                    |
| `backoffUntil`                  | 当前主链路退避到期时间                                     |
| `habitMultiplier`               | Phase 2 预留，用户习惯画像给出的调度倍率；Phase 1 固定为 1 |
| `loadMultiplier`                | 全局负载给出的调度倍率；可选                               |
| `schedulerVersion`              | 调度策略版本，用于统计、排查和后续策略迁移                 |
| `createdAt` / `updatedAt`       | Mongoose timestamps                                        |

当前索引：

```text
{ friendCode: 1 } unique
{ cabinetUserId: 1 }
{ enabled: 1, nextRivalProbeAt: 1, tier: 1 }
{ enabled: 1, nextMapProbeAt: 1, tier: 1 }
{ nextRecentEventAt: 1 }
{ enabled: 1, pendingRecentEventReason: 1, nextRecentEventAt: 1 }
{ enabled: 1, pendingFullUpdateAt: 1 }
```

## `auto_update_play_habits`

Phase 2 可选表。当前 Phase 1 未实现该表和 service；只在 `auto_update_probe_states` 中预留 `habitMultiplier` / `loadMultiplier` 字段。

| 字段             | 含义                                  |
| ---------------- | ------------------------------------- |
| `friendCode`     | 用户好友码                            |
| `hourBuckets`    | 24 个小时桶，记录历史活跃权重         |
| `weekdayBuckets` | 7 个星期桶，记录历史活跃权重          |
| `lastObservedAt` | 最近一次用于画像的 rival/map 活跃时间 |
| `sampleCount`    | 样本数量                              |
| `confidence`     | 画像置信度，样本不足时不调整          |
| `updatedAt`      | 更新时间                              |

画像只影响调度时间，不参与成绩写入。

Phase 2 示例：

```text
当前小时是用户高频小时 -> habitMultiplier = 0.5-0.7
当前小时明显低频 -> habitMultiplier = 1.2-2.0
样本不足 / confidence 低 -> habitMultiplier = 1
```

## `auto_update_tasks`

用于短期任务日志。当前 Phase 1 直接创建 `processing` 任务并在完成后改为 `completed` / `failed`；`queued` / `runAt` 是后续扩展预留，当前不会作为真正队列使用。

| 字段            | 含义                                                                |
| --------------- | ------------------------------------------------------------------- |
| `id`            | 任务 ID                                                             |
| `type`          | `rival_score_probe` / `map_auxiliary_probe` / `fcfs_enrichment`     |
| `friendCode`    | 用户好友码                                                          |
| `cabinetUserId` | 机台用户 ID                                                         |
| `status`        | `processing` / `completed` / `failed`；`queued` / `canceled` 为预留 |
| `priority`      | 任务优先级                                                          |
| `runAt`         | 预留字段；当前任务创建时即 processing                               |
| `attempts`      | 尝试次数                                                            |
| `lastError`     | 最近错误                                                            |
| `metrics`       | 任务耗时、命中数量、返回条数、触发原因等轻量元信息                  |
| `createdAt`     | 创建时间                                                            |
| `updatedAt`     | 更新时间                                                            |

当前 TTL 为 3 天。

## 成绩合并规则

achievement / dxScore：

- 来自 rival score probe。
- `GetUserRivalMusicApi` 每次返回的完整 achievement / dxScore list 直接与用户当前成绩合并。
- 不需要保存并 diff 上一次 rival 结果。
- rival hash / diff 只用于探测“是否有变化”和触发后续任务，不用于决定写入哪些单曲。
- 新值高于当前值才覆盖。
- 也允许同值刷新元信息。

FC/FS：

- 来自 FC/FS enrichment。
- `get_user_recent_event` 每次返回的 FC/FS list 直接与用户当前成绩合并。
- 不使用 `recentEventSince` 过滤，也不保存 recent event 历史 diff；每次返回的 recent event list 都可参与本次合并。
- 如果 rival hash / map delta 在 recent event cooldown 内触发 FC/FS enrichment，不丢弃信号；写入 pending 状态，并在 `nextRecentEventAt` 到期后补跑一次。pending 等待期间不推进 `lastRecentEventAt`。
- 只按 rank 升级，不降级；如果本次 list 没有某首歌，不代表要清空现有 FC/FS。
- 如果 `songName + difficulty` 在当前成绩里匹配到 0 个或多个 score，则跳过该条 event，不做 musicId 消歧，也不触发 `update_score` fallback。
- recent event fingerprint 变化会记录 activity signal，并把稳定后全量 `update_score` 延后到 activity 后 45 分钟。

Rank：

```text
FC: null < fc < fcp < ap < app
FS: null < fs < fsp < fdx < fdxp
```

## DB 与存储压力估算

以下估算基于 2026-06-27 线上 Mongo 取样和 10k Rival-first 外推。它用于容量设计，不是 10k 实测。

### 线上取样

| 集合 / 文档                         |                                    当前样本 |
| ----------------------------------- | ------------------------------------------: |
| 最新 `syncs` 文档 BSON 平均         |                                      ~181KB |
| 最新 `syncs` 文档 BSON p95          |                                      ~355KB |
| 单个 sync 平均成绩条数              |                                       ~1243 |
| `jobs` 中 idle update job BSON 平均 |                                       ~54KB |
| `sdgb_jobs` 最近文档 BSON 平均      |                                       ~63KB |
| 自动更新用户文档 BSON 平均          |                                      ~1.1KB |
| 当前 `syncs` 集合                   |  5905 docs，逻辑大小 ~972MB，storage ~246MB |
| 当前 `sdgb_jobs` 集合               | 81013 docs，逻辑大小 ~9.8GB，storage ~2.1GB |

Rival-first 新方案应避免把完整 rival payload 长期保存在 task 文档里；否则 `sdgb_jobs` 类似的短期日志会成为最大存储压力来源。

### 常驻状态

`auto_update_probe_states` 一人一行。按 10k 用户估算：

| 项           |    估算 |
| ------------ | ------: |
| 单文档大小   |   1-2KB |
| 10k 常驻状态 | 10-20MB |
| 索引         |  5-20MB |

`auto_update_play_habits` Phase 2 才启用。按 24 小时桶 + 7 星期桶估算：

| 项           |    估算 |
| ------------ | ------: |
| 单文档大小   |   1-3KB |
| 10k 常驻状态 | 10-30MB |
| 索引         |  5-20MB |

常驻状态对 DB 压力很小。

### Rival probe 任务日志

Rival probe 三档外推：

| 场景      | Rival probe QPS |   次/天 |
| --------- | --------------: | ------: |
| 全员 cold |             2.8 | 24.0 万 |
| 保守平时  |             5.6 | 48.0 万 |
| 日间主峰  |             7.9 | 68.4 万 |
| 极端主峰  |             9.2 | 79.2 万 |

任务文档必须只保存元信息，不保存完整 rival music list。建议每条 task 控制在 1-2KB：

| TTL  | 48 万/天 @1KB | 48 万/天 @2KB | 68.4 万/天 @2KB |
| ---- | ------------: | ------------: | --------------: |
| 1 天 |        ~0.5GB |        ~1.0GB |          ~1.4GB |
| 3 天 |        ~1.4GB |        ~2.9GB |          ~4.1GB |
| 7 天 |        ~3.4GB |        ~6.7GB |          ~9.6GB |

建议：

- `auto_update_tasks` 当前 TTL 为 3 天。
- 完整 API payload 不入库，只记录 hash、耗时、条数、payload bytes、错误码。
- 需要排查单用户时再打开短期 debug 采样。

### Sync 写入压力

Rival probe 不是每次都写 sync，只有 hash 变化才合并写入。当前线上自动更新用户完整日 score-active 约 28%-36%，单日活跃用户平均 3-4 次成绩变化。外推 10k：

| 项                         |           估算 |
| -------------------------- | -------------: |
| score-active DAU           |      2800-3600 |
| sync merge/write 次数      |  1.0-1.4 万/天 |
| 平均 sync 文档大小         |         ~181KB |
| p95 sync 文档大小          |         ~355KB |
| 每日逻辑写入量（avg）      | ~1.8-2.5GB/day |
| 每日逻辑写入量（p95 上界） | ~3.5-5.0GB/day |

当前 `syncs` 设计只保留每个用户最新一份 sync，因此常驻容量按用户数估：

| 用户数 | avg 181KB | p95 355KB |
| ------ | --------: | --------: |
| 10k    |    ~1.8GB |    ~3.6GB |

注意：即使常驻容量不大，频繁 delete+insert 整份 sync 会带来写放大和碎片。Rival-first 下建议：

- 仍可先沿用“一用户一份最新 sync”的模型。
- 中期考虑改成按 chart 级别 upsert 或分离 `sync_headers` + `scores`，降低整文档重写成本。
- 至少避免在 task / job 文档里重复保存完整成绩 payload。

### FC/FS enrichment 写入压力

Recent event 设计为 change-driven，不对 hot 用户定时全量扫。按 2 bot：

| 限流   |             调用量 |
| ------ | -----------------: |
| 30/min | 4.32 万/天理论上限 |
| 36/min | 5.18 万/天理论上限 |

实际会低于上限，因为有单用户 30min cooldown，且只由 rival hash change、map score-silent change、手动触发产生。cooldown 内的多次触发会合并为 `auto_update_probe_states` 上的一次 pending FC/FS enrichment，到期后补跑一次。

FC/FS 写入只合并当前成绩，不保存 recent event 历史 diff。建议 task 文档只保存：

- 命中数量。
- 更新数量。
- 耗时。
- 错误码。

不要保存完整 recent event HTML。

### DB 设计结论

1. 常驻状态表压力很小，10k 级别只有几十 MB。
2. 最大风险不是状态表，而是 **高频任务日志 + 完整 payload 入库**。
3. Rival probe task 必须轻量化，TTL 建议 1-3 天。
4. `syncs` 常驻容量 10k 下约 2-4GB，但每日重写 1.8-5GB 逻辑数据，需要关注 Mongo 写入和碎片。
5. 如果后续写放大成为瓶颈，再把 score 存储从“整份 sync 文档”拆成 chart 级 upsert。
