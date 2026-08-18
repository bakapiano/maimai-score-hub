# Backend Module 总览

本文档整理 backend Nest module 的职责边界。Sync/Prober Export 职责已按
[目标规范](../specs/score-updates/README.md)更新；对应 rollout 完成前，其余部分仍以当前代码为准。

## 基础约定

- HTTP controller 统一放在 `backend/src/api` 下；业务 module 通常只放 service、schema、领域 helper。
- `BackendApiModule` 负责把 controller 和业务 module 装配在一起；具体 HTTP 路由见 `./api.md`。
- MongoDB 类型与集合字段见 `./db.md`。本文只说明 module 层面的职责和依赖边界。
- `RedisModule` 是 `@Global()` module，其他 module 可以直接注入 `RedisService`。

## 入口与基础设施

| Module             | 路径                                    | 负责功能                                                                                                                                     |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppModule`        | `backend/src/app.module.ts`             | 后端根模块。加载全局配置、定时任务模块、MongoDB 连接、全局 Redis 模块和 `BackendApiModule`。                                                 |
| `BackendApiModule` | `backend/src/api/backend-api.module.ts` | API 聚合模块。导入全部业务 module，注册 `/auth`、`/me`、`/catalog`、`/public`、`/workers`、`/admin` controller，并提供 `SharedSecretGuard`。 |
| `RedisModule`      | `backend/src/common/redis`              | 全局 Redis 基础设施。封装 key prefix、JSON get/set、删除和 keys 查询；用于运行态缓存、队列、锁和 heartbeat，不保存历史日志。                 |

## 业务模块总览

| Module                | 路径                                | 导出服务                                                                       | 负责功能摘要                                                                                            |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `AdminModule`         | `backend/src/modules/admin`         | `AdminSummaryService`、`AdminJobMetricsService` 等                             | 管理后台聚合查询与运维动作入口。                                                                        |
| `AuthModule`          | `backend/src/modules/auth`          | `AuthService`、`AuthGuard`、`QrLoginService`                                   | 登录、JWT 校验、好友请求登录和机台二维码登录。                                                          |
| `AutoUpdateModule`    | `backend/src/modules/auto-update`   | `AutoUpdateSchedulerService`                                                   | Rival-first 自动更新调度、Map auxiliary、FC/FS enrichment 触发和失败退避。                              |
| `BotsModule`          | `backend/src/modules/bots`          | `BotStatusService`、`BotFriendSnapshotService`                                 | DXNet bot 状态、好友快照、可用性选择和不可用任务清理。                                                  |
| `CabinetScoreSyncModule` | `backend/src/modules/cabinet-score-sync` | `CabinetScoreSyncService`                                                   | 当前用户二维码成绩 job、SDGB 结果校验、cleanup fence 和 sync finalization。                             |
| `CatalogModule`       | `backend/src/modules/catalog`       | `CatalogSyncService`                                                           | 使用可续租 Redis lease 串行执行曲库与缺失封面同步。                                                     |
| `CoverModule`         | `backend/src/modules/cover`         | `CoverService`                                                                 | 本地封面文件查找、同步、格式变体生成和封面数量统计。                                                    |
| `JobModule`           | `backend/src/modules/job`           | `JobService`、`JobFriendshipService`、`JobQueueService` 等                     | DXNet worker 任务队列与任务生命周期。                                                                   |
| `MusicModule`         | `backend/src/modules/music`         | `MusicService`                                                                 | 曲库数据、曲库来源配置、曲库定时同步和曲库缓存。                                                        |
| `ProberExportModule`  | `backend/src/modules/prober-export` | `ProberExportService`、reconciliation/worker service                           | Provider 版本游标、自动对账补投、手动导出与 per-user 串行执行。                                         |
| `ScoreExportModule`   | `backend/src/modules/score-export`  | `ScoreExportService`                                                           | 将 B50、等级、版本及指定业务日的合并成绩历史渲染为 PNG 图片。                                             |
| `SdgbWorkerModule`    | `backend/src/modules/sdgb-worker`   | `SdgbJobService`、`SdgbJobDispatcher`                                          | 机台协议 worker 的任务队列、调度和同步调用封装。                                                        |
| `SyncModule`          | `backend/src/modules/sync`          | `SyncService`、`ScoreChangeHistoryService`                                      | current score CAS、增量合并、diff、当前用户单谱面历史与 provider payload 转换。                           |
| `UsersModule`         | `backend/src/modules/users`         | `UsersService`、`CabinetService`、`AccountDeletionService`                     | 用户资料、导入 token、机台绑定、自动更新状态和账号删除。                                                |
| `ObservabilityModule` | `backend/src/modules/observability` | `ClickHouseService`、`ObservabilityIngestService`、`ObservabilityQueryService` | ClickHouse 批量写入、RUM/analytics/structured logs/external API metadata、admin history/realtime 查询。 |

## 模块职责明细

### `AdminModule`

- 面向管理后台聚合数据，不直接表达用户侧业务流程。
- 统计用户、曲库、同步、封面、DXNet job、自动更新，以及 Prober Export version lag、
  claim/attempt/失败退避等运维指标。
- 调用 `CoverService` / `MusicService` / `JobService` / `SdgbJobService` 等服务执行管理操作。
- 按职责拆分为 summary、users、catalog、job query、job metrics、auto-update metrics、prober export metrics 等服务。

### `AuthModule`

- 负责签发和校验 JWT，`AuthGuard` 从 `Authorization: Bearer <jwt>` 解析当前用户。
- `AuthService` 创建好友请求登录 job，轮询登录状态，并在登录 job 满足条件后签发 token。
- `QrLoginService` 处理机台二维码登录：扫码、fast path 查已绑定 `cabinetUserId`，或通过 bot 加 rival + 好友快照反查用户。
- 持有 `qr_login_attempts`，记录 QR 登录异步流程状态。

### `AutoUpdateModule`

- 定时同步开启 `autoUpdate` 且已绑定 `cabinetUserId` 的用户到 `auto_update_probe_states`。
- Rival-first 主链路通过 `SdgbJobDispatcher.getRivalHash()` 拉取 RivalMusic；hash 变化时直接调用 `SyncService.createFromRivalMusic()` 合并写入 sync，不再创建自动 `update_score`。
- Map auxiliary 通过 `SdgbJobDispatcher.getUserMap()` 计算 map fingerprint，用于识别 score-silent 活跃并延长 hot session。
- FC/FS enrichment 每半小时聚合该窗口 `score_changes` 中 achievement/DX Score 发生变化的谱面 CID；pending 按用户合并，到期创建 `musicIds + fcfsOnly=true` 的 background `update_score`。
- Rival/map 活动信号会把稳定后全量 `update_score` 预约到 activity 后 45 分钟；due 时已有 active `update_score` 会覆盖本次收尾需求。
- 每日北京时间 02:00 汇总前一自然日 `score_changes` 中有实际变化、且仍开启自动更新的用户，生成幂等 `daily_full_update` staging task；scheduler 按全局 active `update_score` 水位逐批创建全量 job，并跟踪终态与有限重试。
- 持有 `auto_update_runs`、`auto_update_probe_states`、`auto_update_tasks`，记录每轮执行摘要、用户状态和短期任务日志。
- 处理 rival/map/定向 FC/FS 失败退避；用户习惯画像尚未实现，仅预留 multiplier 字段。

### `CabinetScoreSyncModule`

- 为已登录且已绑定 `cabinetUserId` 的用户创建 `jobType=get_music_score` 的 SDGB job；用户只能提交二维码字符串或图片，`ownerUserId`、好友码和期望 cabinet userId 全由后端填写。
- 用户 API 为 `/me/cabinet-score-jobs`、`/active` 和 `/:jobId`，返回脱敏 view，不暴露原始二维码、cabinet userId、cookie、token 或原始成绩结果。
- 使用短 Redis mutex 串行化同一好友码的手动同步创建，并同时检查 DXNet `jobs` 与 SDGB `get_music_score`，避免两种手动同步并发覆盖。
- Worker 完成后由 `WorkerSdgbJobsController` 把 `get_music_score` 的 completed PATCH 路由到 `CabinetScoreSyncService.finalize()`；只有 `cleanupStatus=succeeded`、绑定 ID 三方一致且成绩映射成功，才允许完成 job。
- 成功后调用统一 score CAS 写入 current sync；version 实际增加时只 best-effort 唤醒
  per-user 自动导出，版本 reconciliation 负责最终补投。
- 详细流程见 [二维码成绩更新事实](./cabinet-qr-score-sync.md)。

### `BotsModule`

- 接收 DXNet worker 上报的 bot 状态，维护 bot 是否可用、好友数量、最近好友快照时间、备注和 `cabinetUserId`。
- 定期清理分配给不可用 bot 的 queued/processing job。
- `BotFriendSnapshotService` 保存和查询 bot 好友列表快照，供 QR 登录反查用户、好友关系判断和 bot 选择使用。
- 提供可用 cabinet bot 的选择逻辑，会综合好友数量和当前 in-flight job 数量做负载均衡。

### `CoverModule`

- 维护 `process.cwd()/covers` 下的本地封面缓存。
- 为公开封面接口提供本地路径查找，并按 `Accept: image/webp` 支持 png/webp 优先级。
- 从 Diving Fish / LXNS 下载封面，并根据当前曲库来源构建跨来源 id 映射。
- 使用 `sharp` 生成 png/webp 双格式变体。
- 自动任务由 `CatalogSyncService` 每 30 分钟在曲库同步后执行；本地 png/webp 均存在时直接跳过，不拉取远程 id map 或封面。管理后台也可手动同步、强制同步或补齐本地变体。

### `JobModule`

- 管理 DXNet worker 任务，任务类型包括 `send_friend_request`、`accept_friend_request`、`update_score` 和 `get_full_friend_list`。
- 创建 job 时默认会取消同一好友码的旧活跃 job，并按任务类型设置初始 stage；`get_full_friend_list` 这类内部刷新任务可跳过取消旧 job。
- 创建和唤醒 job 时写入 BullMQ；worker 直接消费队列，处理 `runAt` 延迟、释放 stale execution、超时失败由后台 sweep 兜底。
- 处理 worker PATCH 回写的状态、stage、进度、profile、result、error 和执行标记。
- `update_score` 通过 commit-first finalization 写入 current sync；version 实际增加后只
  best-effort 唤醒 per-user 自动导出，不创建来源级导出 job。
- 定向 `update_score` 通过谱面 CID 精确映射结果；`fcfsOnly` 结果只参与 FC/FS rank 合并并保留既有 achievement、DX Score 与 rating。
- 支持机台绑定用户的 cabinet fast path：通过 sdgb 加 rival 先建立好友关系，再创建普通 `update_score` job。
- `JobTempCacheService` 用 Redis 临时缓存 `update_score` 中间 FriendVS 解析结果。
- job timeline、worker 外部 API metadata 和相关 structured logs 写入 ClickHouse，由 admin Job Debug 组合查询。

### `MusicModule`

- 持有曲库数据 `musics`。
- 当前曲库同步使用 Diving Fish 数据源，并把外部 payload 转换为内部统一的 `MusicEntity`。
- 曲库本身不再注册独立 cron；`CatalogSyncService` 使用可续租 Redis lease 每 30 分钟串行执行曲库 upsert 与缺失封面补齐。
- `findAll()` 使用 Nest cache 缓存完整曲库列表，曲库同步后清除缓存。
- 管理后台可手动触发曲库同步。

### `ScoreExportModule`

- 根据最新同步成绩和曲库数据生成图片，输出 `image/png`。
- 支持 Best 50、指定等级成绩图、按版本/牌子计划成绩图，以及按业务日合并 diff 后的
  四列成绩历史图。
- 使用 `CoverService` 加载本地封面，使用用户 profile 渲染头部信息。
- `score-export.buckets.ts` 负责分桶、B50 汇总、等级/版本排序；`rendering/` 负责 canvas 渲染、字体和本地素材加载。
- 还提供按好友码批量生成导出图片的能力，供脚本或后续自动化使用。

### `ProberExportModule`

- `prober_export_states` 保存用户在 Diving Fish/LXNS 的最后成功 score version、失败退避
  和 Mongo claim；token 仍只保存在 user 文档。
- 自动导出通过 state 游标与 `syncs.__v` 的差异发现，不与 DXNet/二维码/Rival/FCFS
  source job 一一绑定。
- score commit 后可 best-effort 添加稳定 per-user BullMQ wake；定期 reconciliation
  批量对账并补回丢失 delivery。
- 两个 Backend replica 使用 Redis 可续期 user lease 串行外部上传，再用 Mongo 原子
  claimToken fence state 写入。
- `prober_export_jobs` 保存实际 auto attempt 和立即创建的 manual job，记录 requested/exported
  score version 与完整 provider 结果。
- 手动导出与自动导出使用同一用户 lease/claim，成功游标只通过 `$max` 前进。
- 详细规范见
  [Diving-Fish / LXNS 成绩导出规范](../specs/prober-export/README.md)。

### `SdgbWorkerModule`

- 管理 sdgb-worker 使用的机台协议任务，任务类型包括 `scan_qr`、`get_rival_hash`、`get_user_map`、`add_rival` 和 `get_music_score`。
- `SdgbJobService` 负责写入 Mongo + BullMQ、worker PATCH 和等待完成。
- sdgb-worker 按 Probe/Interactive 两条 BullMQ lane 消费，不再通过 HTTP claim/next 认领任务；worker 通过 heartbeat 接口上报 role、能力和状态。
- Mongo TTL 清理历史 job。
- `SdgbJobDispatcher` 把“入队 + 等待完成 + 返回 result”封装成同步调用，供登录、机台绑定、自动更新和 bot 绑定使用。
- `get_music_score` 不是 dispatcher 同步调用：用户 façade 创建后由前端轮询；job 带 owner、stage、progress 和 cleanup 状态，终态会擦除 `payload.qrCode`。

### `SyncModule`

- 将 DXNet job result、sdgb RivalMusic 或已登录用户的 `UserMusicDetail[]`
  转成标准 delta，并统一提交到每用户唯一 current sync。
- 使用 `friendCode + __v` CAS；冲突时必须重新读取最新 current 后 merge，不再
  `deleteMany + create`。
- 合并策略保留更高的 achievement、dxScore、FC 和 FS，元数据来自最新曲库。
- 定向 FC/FS `update_score` 按谱面 CID 映射，并通过统一 rank merge 更新 current。
- 对外提供当前用户最新同步成绩查询、按歌曲/难度/谱面类型过滤的
  `/me/score-changes`，以及全部谱面的 `/me/score-history` 时间窗 feed；历史 service
  始终附加 JWT `friendCode` 所有权条件。
- `ProberExportMapService` 缓存 Diving Fish 与 LXNS 的曲目 id 映射，支持在不同曲库来源下导出。
- 为 ProberExportModule 提供一次性 current export snapshot 与两个 provider payload 转换；
  自动导出状态不再存入 sync。
- `createFromUserMusic()` 映射 achievement、DX Score、FC/AP 和 FS/FDX；`syncStatus=5 (SyncPlay)` 不映射为 Full Sync。

### `UsersModule`

- 管理用户主数据：好友码、用户名/密码、导入 token、DXNet profile、最近活跃时间、机台绑定和自动更新开关。
- `UsersService` 提供用户查找、创建、更新、密码登录、批量 profile patch 和活跃状态查询。部分旧自动更新节流字段仍保留在 user schema，但 Rival-first 状态已迁移到 `auto_update_probe_states`。
- `CabinetService` 处理机台二维码绑定：解码 QR、调用 sdgb 扫码、用最新 sync 与机台成绩做身份匹配。
- `AccountDeletionService` 删除账号时同步清理该用户的 sync、`score_changes`、业务 job、
  `prober_export_states` 和用户可归属的 export attempt 数据。
- 其他模块通常通过好友码读取用户，通过用户 `_id` 更新设置。

### `ObservabilityModule`

- 后端 HTTP interceptor 记录 API route、status、duration、request/response bytes 和 trace/request id。
- `/observability/rum` 和 `/observability/events` 接收前端 RUM / analytics 批量上报。
- `/workers/logs/:kind/batches` 接收 dxnet/sdgb structured logs 并写入 ClickHouse `structured_logs`。
- `/workers/dxnet/jobs/:jobId/api-calls` 接收外部 API metadata 并写入 ClickHouse `external_api_calls`。
- backend 内部外部依赖也写入 `external_api_calls`：Diving Fish、LXNS、曲库、封面下载、成绩图远程图片。
- `/workers/:kind/external-api-calls` 提供通用 worker 外部调用上报入口，供 sdgb-worker 等 tracked/untracked worker 使用。
- `JobService` / `SdgbJobService` 写入 ClickHouse `job_timeline_events`，Job Debug 不再依赖旧 Mongo/Redis debug logs。
- ClickHouse 写入失败只丢弃 observability event，不阻塞业务主链路。

## 常见修改定位

| 需求类型                                                     | 优先查看模块                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| 登录、JWT、好友请求登录、QR 登录                             | `AuthModule`、`JobModule`、`SdgbWorkerModule`                     |
| 用户资料、导入 token、机台绑定                               | `UsersModule`、`SyncModule`                                       |
| DXNet 手动更新成绩、worker 任务调度                          | `JobModule`、`BotsModule`                                         |
| 用户二维码更新成绩、Login/Logout cleanup、sync finalization | `CabinetScoreSyncModule`、`SdgbWorkerModule`、`SyncModule`         |
| 自动更新、Rival-first probe、Map auxiliary、FC/FS enrichment | `AutoUpdateModule`、`SdgbWorkerModule`、`SyncModule`、`JobModule` |
| 曲库同步                                                     | `MusicModule`                                                     |
| 封面同步和封面静态返回                                       | `CoverModule`                                                     |
| 成绩图导出                                                   | `ScoreExportModule`、`SyncModule`、`CoverModule`                  |
| sdgb-worker 通用机台协议任务                                 | `SdgbWorkerModule`                                                |
| 管理后台统计和运维动作                                       | `AdminModule` 以及被调用的具体业务模块                            |
| worker 日志、外部 API metadata、Job Debug 时间线             | `ObservabilityModule`                                             |
