# Rival-first 主方案

本方案把 `GetUserRivalMusicApi` 作为自动更新主探测接口。每次探测都直接得到 rival music 列表，可以同时完成：

1. 计算成绩 hash。
2. 判断 achievement / dxScore 是否变化。
3. 将本次返回的完整成绩 list 与用户当前成绩直接合并。
4. 触发 FC/FS enrichment 候选任务。

`GetUserMapApi` 不再作为主探测链路，只作为辅助信号，用于识别 score-silent 活跃。

## 为什么选择 Rival-first

如果先 map 再 rival，成绩变化路径是：

```text
GetUserMapApi
  -> map distance changed
  -> GetUserRivalMusicApi
  -> write score
```

Rival-first 是：

```text
GetUserRivalMusicApi
  -> hash changed? write score
```

优势：

- 对真正有成绩变化的用户少一次 round-trip。
- 不需要维护“map delta 后再 enqueue rival”的主链路依赖。
- hash 变化时能立即把本次完整 achievement / dxScore list 与现有成绩合并；hash/diff 只用于探测，不用于生成增量写入列表。
- 当前实测显示 RivalMusic 延迟与 Map 接近。

需要补足：

- RivalMusic 没有 FC/FS。
- Rival hash 不变时，用户仍可能正在游玩，或只提升了 FC/FS。
- 因此需要 Map auxiliary 和 recent event enrichment。

## 实测对比

2026-06-27 对线上自动更新用户随机抽样 100 个 cabinet userId，本地直连顺序调用：

| API                    |  成功率 |  avg |  p50 |   p95 |   p99 | avg payload |                  返回规模 |
| ---------------------- | ------: | ---: | ---: | ----: | ----: | ----------: | ------------------------: |
| `GetUserMapApi`        | 100/100 | 74ms | 63ms | 130ms | 410ms |      10.6KB |             ~110 map rows |
| `GetUserRivalMusicApi` | 100/100 | 75ms | 69ms | 131ms | 191ms |       110KB | ~761 songs / 1270 details |

结论：

- “RivalMusic 一定明显更慢”不成立。
- RivalMusic 的主要额外成本是 payload / JSON 解析 / hash 计算，约 10 倍 payload。
- 因为它能直接更新成绩，主链路选择 Rival-first 更划算。

## 10k QPS 重新核算

三档：

| tier | Rival probe interval |
| ---- | -------------------: |
| hot  |               10 min |
| warm |               30 min |
| cold |               1 hour |

Rival probe QPS：

```text
hot / 600 + warm / 1800 + cold / 3600
```

| 场景      | 分布               |  QPS | 每小时调用 | 每日调用（若全天保持该分布） |
| --------- | ------------------ | ---: | ---------: | ---------------------------: |
| 全员 cold | 0 / 0 / 10000      |  2.8 |     1.0 万 |                      24.0 万 |
| 保守平时  | 1000 / 5000 / 4000 |  5.6 |     2.0 万 |                      48.0 万 |
| 日间主峰  | 2500 / 6000 / 1500 |  7.9 |    2.85 万 |                      68.4 万 |
| 极端主峰  | 3500 / 5500 / 1000 |  9.2 |     3.3 万 |                      79.2 万 |
| 全员 hot  | 10000 / 0 / 0      | 16.7 |     6.0 万 |                     144.0 万 |

当前线上自动更新用户的完整日成绩活跃率约 28%-36%，最近 7 天 score-active 用户约 84.5%。按 10k 放大，日间主峰使用 `2500 hot / 6000 warm / 1500 cold` 作为容量设计点是合理的。

## Map auxiliary

Map auxiliary 不是主链路。当前 Phase 1 会为所有开启自动更新且绑定 cabinet userId 的用户初始化 `nextMapProbeAt`，之后按 tier 间隔到期执行：

| 场景 | Map auxiliary |
| ---- | ------------: |
| hot  |        30 min |
| warm |        60 min |
| cold |        60 min |

Map 变化但 rival hash 未变时：

1. 延长或升为 hot。
2. 不写 achievement / dxScore。
3. 请求一次 FC/FS enrichment；如果 recent event cooldown 未到，则记录 pending，到期后补跑一次。

## 当前执行控制与目标 QPS

```text
AUTO_UPDATE_RIVAL_BATCH_LIMIT = 480
AUTO_UPDATE_RIVAL_CONCURRENCY = 4
AUTO_UPDATE_MAP_BATCH_LIMIT = 120
AUTO_UPDATE_MAP_CONCURRENCY = 2
```

这些是 backend scheduler 当前已实现的生产侧控制。sdgb-worker 已通过 BullMQ 多并发消费，并实现 global/per-API token bucket；8 qps sustained / 10-12 qps burst 是 10k 容量目标对应的默认限流方向。
