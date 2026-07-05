# 自动更新 Rival-first 代码现实与 10k 外推

本文档描述当前 Rival-first Phase 1 代码现实，以及基于线上数据外推的 10k 容量目标。

目标：支持 **1 万用户开启自动更新**。主链路直接使用 `GetUserRivalMusicApi` 作为探测与成绩写入入口：一次调用同时判断成绩 hash，并在 hash 变化时把本次完整 achievement / dxScore list 与用户现有成绩合并。`GetUserMapApi` 只作为辅助探活，用来补充识别“用户游玩了但成绩 hash 没变”的 score-silent 场景。

## 设计原则

- **Rival-first**：主探测就是 `GetUserRivalMusicApi`，不再先 map 再 rival。
- **Diff 只用于探测，不用于写入**：rival hash / map fingerprint 只决定是否触发后续流程；实际写入始终用本次返回 list 与用户当前成绩按规则合并。
- **Map 辅助，不做主链路**：`GetUserMapApi` 只用于 score-silent 活跃、冷启动校验和上线观测。
- **FC/FS 独立补全**：`GetUserRivalMusicApi` 没有 FC/FS，使用 `addRival + get recent event` 低频补最近 FC/AP/FS/FDX。
- **三条链路解耦**：rival score probe、map auxiliary probe、FC/FS enrichment 独立记录任务和失败状态。
- **Phase 1 执行控制**：backend 用 batch limit、concurrency、cooldown 和 backoff 控制生产节奏；sdgb-worker 用 BullMQ 并发消费和 global/per-API token bucket 控制实际 QPS。
- **数据驱动调参**：用新链路指标记录 rival hash delta、map delta、recent event 命中率，再调分层和限流。

## 实测依据

2026-06-27 对线上自动更新用户随机抽样 100 个 cabinet userId，本地直连顺序调用：

| API                    |  成功率 |  avg |  p50 |   p95 | avg payload |                  返回规模 |
| ---------------------- | ------: | ---: | ---: | ----: | ----------: | ------------------------: |
| `GetUserMapApi`        | 100/100 | 74ms | 63ms | 130ms |      10.6KB |             ~110 map rows |
| `GetUserRivalMusicApi` | 100/100 | 75ms | 69ms | 131ms |       110KB | ~761 songs / 1270 details |

结论：

- RivalMusic 延迟没有明显劣于 Map。
- RivalMusic payload 约为 Map 的 10 倍，但它能直接完成成绩探测与写入。
- 因此主方案选择 Rival-first，Map 只补盲。

## 三条链路

| 链路                | 输入                                                 | 输出                                                                | 频率                   |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- | ---------------------- |
| Rival Score Probe   | 开启自动更新且绑定 cabinet userId 的用户             | achievement / dxScore / rating / lastRivalHash / 活跃档位           | 主链路，10m / 30m / 1h |
| Map Auxiliary Probe | 需要识别 score-silent 活跃的用户                     | map distance fingerprint、是否延长 hot session、是否触发 FC/FS 补全 | 辅助链路，低频         |
| FC/FS Enrichment    | rival score 变化或 map score-silent 活跃后的候选用户 | 最近 FC/AP/FS/FDX 合并结果                                          | 低频、按用户节流       |

## Phase 1 当前参数

| 项                           | 当前代码默认                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 活跃分层                     | hot / warm / cold 三档                                                                                          |
| hot rival score probe        | 10 分钟                                                                                                         |
| warm rival score probe       | 30 分钟                                                                                                         |
| cold rival score probe       | 1 小时                                                                                                          |
| map auxiliary probe          | hot 30 分钟；warm/cold 1 小时                                                                                   |
| recent event 单用户 cooldown | 30 分钟                                                                                                         |
| recent event 执行延迟        | 3 分钟                                                                                                          |
| stable full update debounce  | 45 分钟                                                                                                         |
| rival score probe 执行控制   | 每轮最多 480 个 due state，scheduler 并发 4                                                                     |
| map auxiliary 执行控制       | 每轮最多 120 个 due state，scheduler 并发 2                                                                     |
| FC/FS enrichment 执行控制    | 单用户 cooldown；cooldown 内合并为 pending，到期生成 DXNet `get_user_recent_event` job；无全局 qps token bucket |
| sdgb 执行模型                | backend enqueue BullMQ `sdgb-worker-jobs`；sdgb-worker 多并发消费并按 API token bucket 限流                     |

## 10k 用户主链路 QPS 估算

Rival probe QPS 公式：

```text
hot / 600 + warm / 1800 + cold / 3600
```

| 场景              | 假设分布                         | Rival probe QPS | 每日调用量（若全天保持该分布） |
| ----------------- | -------------------------------- | --------------: | -----------------------------: |
| 全员 cold 下限    | 10000 cold                       |         2.8 qps |                        24.0 万 |
| 保守平时          | 1000 hot / 5000 warm / 4000 cold |         5.6 qps |                        48.0 万 |
| 日间主峰          | 2500 hot / 6000 warm / 1500 cold |         7.9 qps |                        68.4 万 |
| 极端主峰          | 3500 hot / 5500 warm / 1000 cold |         9.2 qps |                        79.2 万 |
| 全员 hot 理论上限 | 10000 hot                        |        16.7 qps |                       144.0 万 |

上表 QPS 是容量目标外推；sdgb-worker 已实现 global + per-API token bucket，backend 仍通过 batch/concurrency/backoff 控制生产节奏。

## 文档拆分

| 文档                     | 内容                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| `rival-first.md`         | Rival-first 主方案、实测对比、10k QPS 估算                                      |
| `activity-tiering.md`    | hot / warm / cold 分层与状态流转                                                |
| `pipeline-design.md`     | rival score probe / map auxiliary / FCFS enrichment 三链路设计                  |
| `rate-limits.md`         | 当前执行控制、sdgb-worker token bucket 和仍未实现的 DXNet recent event 全局限流 |
| `data-model.md`          | 当前状态表、任务日志表、关键字段                                                |
| `settled-full-update.md` | 稳定后全量 `update_score` 的 debounce 代码事实                                  |
| `metrics-and-rollout.md` | 压测、指标、breaking cutover 和参数收敛                                         |
| `phase1-code-facts.md`   | 当前 Phase 1 已实现代码事实                                                     |
