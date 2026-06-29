# 当前实现与问题

本文以线上 `main` 代码和 2026-06-29 线上只读数据为准。

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

当前工作区 `dev` 已经出现更合理的方向：

- `RedisModule` / `RedisService`
- `WorkerLogsService` 写 Redis Stream
- `JobApiLogService` 写 Redis JSON 且只保存 `bodySize`
- API 路径拆到 `backend/src/api/*`

但线上 Server 5 当前没有 Redis 容器，因此这些不能当成线上事实。

## 核心问题

### 1. raw log 与业务事实混在 Mongo

`worker_logs` 是 console line tail，本质是短期排障数据。线上有 `1,933,769` 条，其中 `1,914,194` 条已经超过 schema 期望的 2h 保留时间。

原因不是业务量失控，而是线上 `worker_logs.ts_1` index 没有 `expireAfterSeconds`。Mongoose 不会自动把已存在的普通索引改成 TTL 索引。

### 2. job API debug 保存了大响应体

`job_api_logs` 线上有 `102,169` 条，逻辑大小 `6.96GB`。过去 24h 只新增 `9,412` 条，但历史超过 24h 的仍有 `92,757` 条，因为线上 `createdAt_1` index 同样没有 TTL。

更大的问题是 schema 直接保存 `responseBody`。这让 debug 页面的一次排查成本变成 Mongo 存储和查询成本。

### 3. 看板依赖 grep 日志

线上 `AdminService.getAutoUpdateMetrics()` 中，567 rate-limit 统计来自 `worker_logs` 里匹配 `/(567)/`。

这会带来几个问题：

- 依赖 raw log 存储保留窗口。
- 字符串格式变化会破坏指标。
- 查询窗口越长越容易扫大集合。
- 业务指标和日志文本耦合，alert 无法可靠复用。

### 4. API 和存储边界按页面长出来

现在的 debug 页面是：

- worker logs 一套 API
- job api logs 一套 API
- job search 一套 API
- auto update metrics 一套聚合
- prober export metrics 一套聚合

它们都能工作，但没有统一的事件/指标模型。后续新增 sdgb-worker、prober export、DXNet recent event、alert 订阅时，会继续复制“新 API + 新存储 + 新页面”的模式。

## 不应该继续做的事

- 不继续把 console logs 写入 Mongo。
- 不继续保存 raw `responseBody` 到 Mongo。
- 不把“最近 567 次数”这类指标建立在 grep 日志文本上。
- 不为每个 admin debug widget 新建一套入库 API。
- 不在当前数据量下直接引入重型日志平台来掩盖模型问题。

## 需要保留的东西

- `jobs` / `sdgb_jobs` 仍是业务状态和调试主线。
- `auto_update_runs` 是 cron 是否执行、每轮结果的低频事实，应该继续保留。
- `bot_statuses` 是 bot 可用性 source of truth。
- admin 页面仍需要“点开一个 job，看它的状态、阶段、外部 API 调用序列和关键错误”。
- worker logs 最近 tail 仍有价值，但应该是短窗口 debug tail。

