# 当前实现与问题

本文以线上 `main` 代码和 2026-06-29 线上只读数据为准，记录的是重构前的历史基线，不代表 PR #8 / dev 的当前实现。PR #8 已移除旧 `WorkerLogsModule`、`JobApiLogService`、Redis Stream worker logs 和旧 `api-logs` endpoints。

## 当前 admin debug 入口

线上 `main` 的 debug/monitor 入口分散在多个模块：

| 功能 | 线上代码位置 | 存储 |
| --- | --- | --- |
| Worker 控制台日志 | `backend/src/modules/worker-logs/*`，worker `log-shipper.ts` | Mongo `worker_logs` |
| 单个 DXNet job 外部 API 日志 | `backend/src/modules/job/api-log/*` | Mongo `job_api_logs`，保存 `responseBody` |
| job 查询/调试 | `AdminController.getJobApiLogs()`、`AdminService.searchJobs()` | Mongo `jobs` + `job_api_logs` |
| 自动更新看板 | `AdminService.getAutoUpdateMetrics()` | `auto_update_runs`、`jobs`、`worker_logs` |
| prober export 看板 | `AdminService.getProberExportMetrics()` | `jobs.autoExportResult` |
| bot 状态 | `bot_statuses` | Mongo |

当前工作区 `dev` 已经出现 Redis 方向：

- `RedisModule` / `RedisService`
- `WorkerLogsService` 写 Redis Stream
- `JobApiLogService` 写 Redis JSON 且只保存 `bodySize`
- API 路径拆到 `backend/src/api/*`

但用户现在希望上 ClickHouse 做历史分析，因此 Redis 方向需要收缩为运行态组件，不再作为日志/指标主方案。

## 核心问题

### 1. raw log 与业务事实混在 Mongo

`worker_logs` 是 console line tail，本质是观测数据，不是业务事实。线上有 `1,933,769` 条，其中 `1,914,194` 条已经超过 schema 期望的 2h 保留时间。

线上 `worker_logs.ts_1` index 没有 `expireAfterSeconds`。这只是现状证据，用于说明新方案为什么不继续把观测日志写入 Mongo。

### 2. job API debug 保存了大响应体

`job_api_logs` 线上有 `102,169` 条，逻辑大小 `6.96GB`。过去 24h 只新增 `9,412` 条，但历史超过 24h 的仍有 `92,757` 条。这个现状用于说明 raw body 入库成本。

更大的问题是 schema 直接保存 `responseBody`。这让 debug 页面的一次排查成本变成 Mongo 存储和查询成本。

### 3. admin portal 指标口径不可靠

目前一些指标来自：

- grep `worker_logs` 文本。
- 临时聚合 `jobs`。
- 从 job duration 粗略推断 API latency。
- 页面级别各自拼查询。

这会造成：

- 口径不可解释。
- 字符串格式变化会破坏指标。
- 没有 DAU / frontend load time / API route latency 的真实数据。
- 不能区分实时监控和历史分析。

### 4. API 和存储边界按页面长出来

现在的 debug 页面是：

- worker logs 一套 API。
- job api logs 一套 API。
- job search 一套 API。
- auto update metrics 一套聚合。
- prober export metrics 一套聚合。

它们都能工作，但没有统一的数据模型。后续新增 RUM、DAU、usage、alert 时，如果继续沿用这个模式，会继续积累无法解释的 admin 指标。

## Breaking change 后不保留的东西

- 不继续把 console logs 写入 Mongo。
- 不继续保存 raw `responseBody` 到 Mongo。
- 不用 grep 日志文本做 dashboard source of truth。
- 不用 `jobs` 临时推断 API latency / route QPS。
- 不保留每个 admin debug widget 自己入库的模式。

## 需要保留的东西

- `jobs` / `sdgb_jobs` 仍是业务状态和调试主线。
- `auto_update_runs` 是 cron 是否执行、每轮结果的业务事实，继续保留。
- `bot_statuses` 是 bot 可用性 source of truth。
- admin 仍需要 job debug，但数据来源变成 Mongo + ClickHouse + artifact。
- worker logs 仍有价值，但应进入 ClickHouse structured logs，而不是 Mongo。
