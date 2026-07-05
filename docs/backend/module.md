# Backend Module 总览

本文档整理 backend 当前 Nest module 的职责边界。来源以 `backend/src/app.module.ts`、`backend/src/api/backend-api.module.ts`、`backend/src/common/redis/redis.module.ts` 和 `backend/src/modules/**/*.module.ts` 为准。

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
| `CoverModule`         | `backend/src/modules/cover`         | `CoverService`                                                                 | 本地封面文件查找、同步、格式变体生成和封面数量统计。                                                    |
| `JobModule`           | `backend/src/modules/job`           | `JobService`、`JobFriendshipService`、`JobQueueService` 等                     | DXNet worker 任务队列与任务生命周期。                                                                   |
| `MusicModule`         | `backend/src/modules/music`         | `MusicService`                                                                 | 曲库数据、曲库来源配置、曲库定时同步和曲库缓存。                                                        |
| `ScoreExportModule`   | `backend/src/modules/score-export`  | `ScoreExportService`                                                           | 将同步成绩渲染为 PNG 图片。                                                                             |
| `SdgbWorkerModule`    | `backend/src/modules/sdgb-worker`   | `SdgbJobService`、`SdgbJobDispatcher`                                          | 机台协议 worker 的任务队列、调度和同步调用封装。                                                        |
| `SyncModule`          | `backend/src/modules/sync`          | `SyncService`                                                                  | 成绩同步快照落库、成绩合并和导出到 prober。                                                             |
| `UsersModule`         | `backend/src/modules/users`         | `UsersService`、`CabinetService`、`AccountDeletionService`                     | 用户资料、导入 token、机台绑定、自动更新状态和账号删除。                                                |
| `ObservabilityModule` | `backend/src/modules/observability` | `ClickHouseService`、`ObservabilityIngestService`、`ObservabilityQueryService` | ClickHouse 批量写入、RUM/analytics/structured logs/external API metadata、admin history/realtime 查询。 |

## 模块职责明细

### `AdminModule`

- 面向管理后台聚合数据，不直接表达用户侧业务流程。
- 统计用户、曲库、同步、封面、DXNet job、自动更新、prober 导出等运维指标。
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
- FC/FS enrichment 由 rival hash 变化或 map delta 请求触发：cooldown 内先挂 pending，到期后先 sdgb `addRival`，再创建 DXNet `get_user_recent_event` job。
- Rival/map/recent event 任一活动信号都会把稳定后全量 `update_score` 预约到 activity 后 45 分钟；如果 due 时已有 active `update_score`，直接视为覆盖并清 pending。
- 持有 `auto_update_runs`、`auto_update_probe_states`、`auto_update_tasks`，记录每轮执行摘要、用户状态和短期任务日志。
- 处理 rival/map/recent 失败退避；用户习惯画像尚未实现，仅预留 multiplier 字段。

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
- 每天 03:00 Asia/Shanghai 自动增量同步封面，管理后台也可手动同步、强制同步或补齐本地变体。

### `JobModule`

- 管理 DXNet worker 任务，任务类型包括 `send_friend_request`、`accept_friend_request`、`update_score`、`get_user_recent_event` 和 `get_full_friend_list`。
- 创建 job 时默认会取消同一好友码的旧活跃 job，并按任务类型设置初始 stage；`get_full_friend_list` 这类内部刷新任务可跳过取消旧 job。
- 创建和唤醒 job 时写入 BullMQ；worker 直接消费队列，处理 `runAt` 延迟、释放 stale execution、超时失败由后台 sweep 兜底。
- 处理 worker PATCH 回写的状态、stage、进度、profile、result、error 和执行标记。
- `update_score` 成功完成后会触发 `SyncService.createFromJob()` 写入同步成绩，并按用户设置执行自动导出。
- `get_user_recent_event` 成功完成后会触发 `SyncService.mergeRecentEvents()` 合并唯一命中的 FC/FS；重名或缺失匹配会跳过，不再创建 ambiguous fallback。recent event fingerprint 变化会记录 activity signal。
- 支持机台绑定用户的 cabinet fast path：通过 sdgb 加 rival 先建立好友关系，再创建普通 `update_score` job。
- `JobTempCacheService` 用 Redis 临时缓存 `update_score` 中间 FriendVS 解析结果。
- job timeline、worker 外部 API metadata 和相关 structured logs 写入 ClickHouse，由 admin Job Debug 组合查询。

### `MusicModule`

- 持有曲库数据 `musics`。
- 当前曲库同步使用 Diving Fish 数据源，并把外部 payload 转换为内部统一的 `MusicEntity`。
- 启动时注册曲库同步 cron，表达式来自 `MUSIC_SYNC_CRON`，默认每 6 小时。
- `findAll()` 使用 Nest cache 缓存完整曲库列表，曲库同步后清除缓存。
- 管理后台可手动触发曲库同步。

### `ScoreExportModule`

- 根据最新同步成绩和曲库数据生成图片，输出 `image/png`。
- 支持 Best 50、指定等级成绩图、按版本/牌子计划成绩图。
- 使用 `CoverService` 加载本地封面，使用用户 profile 渲染头部信息。
- `score-export.buckets.ts` 负责分桶、B50 汇总、等级/版本排序；`rendering/` 负责 canvas 渲染、字体和本地素材加载。
- 还提供按好友码批量生成导出图片的能力，供脚本或后续自动化使用。

### `SdgbWorkerModule`

- 管理 sdgb-worker 使用的机台协议任务，任务类型包括 `scan_qr`、`get_rival_hash`、`get_user_map` 和 `add_rival`。
- `SdgbJobService` 负责写入 Mongo + BullMQ、worker PATCH 和等待完成。
- sdgb-worker 直接消费 BullMQ，不再通过 HTTP claim/next 认领任务；worker 通过 heartbeat 接口上报状态。
- Mongo TTL 清理历史 job。
- `SdgbJobDispatcher` 把“入队 + 等待完成 + 返回 result”封装成同步调用，供登录、机台绑定、自动更新和 bot 绑定使用。

### `SyncModule`

- 将 DXNet worker 的 job result 或 sdgb RivalMusic list 转换为 `SyncScore`，写入最新同步快照。
- 同一用户只保留最新 sync；新成绩会和上一份 sync 合并，避免单次抓取缺项时丢失旧成绩。
- 合并策略保留更高的 achievement、dxScore、FC 和 FS，元数据来自最新曲库。
- `mergeRecentEvents()` 把 recent event FC/FS list 与当前成绩按 rank 合并；只处理能唯一定位到当前 score 的 event。
- 对外提供当前用户最新同步成绩查询。
- `ProberExportMapService` 缓存 Diving Fish 与 LXNS 的曲目 id 映射，支持在不同曲库来源下导出。
- 支持把最新 sync 上传到 Diving Fish 或 LXNS，并记录自动导出结果。

### `UsersModule`

- 管理用户主数据：好友码、用户名/密码、导入 token、DXNet profile、最近活跃时间、机台绑定和自动更新开关。
- `UsersService` 提供用户查找、创建、更新、密码登录、批量 profile patch 和活跃状态查询。部分旧自动更新节流字段仍保留在 user schema，但 Rival-first 状态已迁移到 `auto_update_probe_states`。
- `CabinetService` 处理机台二维码绑定：解码 QR、调用 sdgb 扫码、用最新 sync 与机台成绩做身份匹配。
- `AccountDeletionService` 删除账号时同步清理该用户的 sync 和 job 数据。
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
| 手动更新成绩、worker 任务调度                                | `JobModule`、`BotsModule`                                         |
| 自动更新、Rival-first probe、Map auxiliary、FC/FS enrichment | `AutoUpdateModule`、`SdgbWorkerModule`、`SyncModule`、`JobModule` |
| 曲库同步                                                     | `MusicModule`                                                     |
| 封面同步和封面静态返回                                       | `CoverModule`                                                     |
| 成绩图导出                                                   | `ScoreExportModule`、`SyncModule`、`CoverModule`                  |
| sdgb-worker 机台协议任务                                     | `SdgbWorkerModule`                                                |
| 管理后台统计和运维动作                                       | `AdminModule` 以及被调用的具体业务模块                            |
| worker 日志、外部 API metadata、Job Debug 时间线             | `ObservabilityModule`                                             |
