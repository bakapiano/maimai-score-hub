# Backend Module 总览

本文档整理 backend 当前 Nest module 的职责边界。来源以 `backend/src/app.module.ts`、`backend/src/api/backend-api.module.ts`、`backend/src/common/redis/redis.module.ts` 和 `backend/src/modules/**/*.module.ts` 为准。

## 基础约定

- HTTP controller 统一放在 `backend/src/api` 下；业务 module 通常只放 service、schema、领域 helper。
- `BackendApiModule` 负责把 controller 和业务 module 装配在一起；具体 HTTP 路由见 `backend/docs/api.md`。
- MongoDB 类型与集合字段见 `backend/docs/db.md`。本文只说明 module 层面的职责和依赖边界。
- `RedisModule` 是 `@Global()` module，其他 module 可以直接注入 `RedisService`。

## 入口与基础设施

| Module             | 路径                                | 负责功能                                                                                          |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `AppModule`        | `backend/src/app.module.ts`         | 后端根模块。加载全局配置、定时任务模块、MongoDB 连接、全局 Redis 模块和 `BackendApiModule`。      |
| `BackendApiModule` | `backend/src/api/backend-api.module.ts` | API 聚合模块。导入全部业务 module，注册 `/auth`、`/me`、`/catalog`、`/public`、`/workers`、`/admin` controller，并提供 `SharedSecretGuard`。 |
| `RedisModule`      | `backend/src/common/redis`          | 全局 Redis 基础设施。封装 key prefix、JSON get/set、删除、keys、Redis Stream 写入与反向读取。     |

## 业务模块总览

| Module                 | 路径                                      | 导出服务                                                                    | 负责功能摘要                                                                 |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AdminModule`          | `backend/src/modules/admin`               | `AdminService`                                                              | 管理后台聚合查询与运维动作入口。                                             |
| `AuthModule`           | `backend/src/modules/auth`                | `AuthService`、`AuthGuard`、`QrLoginService`                                | 登录、JWT 校验、好友请求登录和机台二维码登录。                               |
| `AutoUpdateModule`     | `backend/src/modules/auto-update`         | `AutoUpdateSchedulerService`                                                | 自动更新调度、hash 检查、强制触发与自动更新历史。                            |
| `BotsModule`           | `backend/src/modules/bots`                | `BotStatusService`、`BotFriendSnapshotService`                              | DXNet bot 状态、好友快照、可用性选择和告警。                                 |
| `CoverModule`          | `backend/src/modules/cover`               | `CoverService`                                                              | 本地封面文件查找、同步、格式变体生成和封面数量统计。                         |
| `JobModule`            | `backend/src/modules/job`                 | `JobService`、`JobTempCacheService`、`JobApiLogService`                     | DXNet worker 任务队列与任务生命周期。                                        |
| `MusicModule`          | `backend/src/modules/music`               | `MusicService`                                                              | 曲库数据、曲库来源配置、曲库定时同步和曲库缓存。                             |
| `ScoreExportModule`    | `backend/src/modules/score-export`        | `ScoreExportService`                                                        | 将同步成绩渲染为 PNG 图片。                                                  |
| `SdgbWorkerModule`     | `backend/src/modules/sdgb-worker`         | `SdgbJobService`、`SdgbJobDispatcher`                                       | 机台协议 worker 的任务队列、调度和同步调用封装。                             |
| `SyncModule`           | `backend/src/modules/sync`                | `SyncService`                                                               | 成绩同步快照落库、成绩合并和导出到 prober。                                  |
| `SystemSettingsModule` | `backend/src/modules/system-settings`     | `SystemSettingsService`                                                     | 全局系统设置，目前主要是 `cabinetOnlyMode`。                                  |
| `UsersModule`          | `backend/src/modules/users`               | `UsersService`、`CabinetService`、`AccountDeletionService`                  | 用户资料、导入 token、机台绑定、自动更新状态和账号删除。                     |
| `WorkerLogsModule`     | `backend/src/modules/worker-logs`         | `WorkerLogsService`                                                         | worker 日志上报、查询、workerId 列表和日志指标聚合。                         |

## 模块职责明细

### `AdminModule`

- 面向管理后台聚合数据，不直接表达用户侧业务流程。
- 统计用户、曲库、同步、封面、DXNet job、自动更新、prober 导出等运维指标。
- 调用 `CoverService` / `MusicService` / `JobService` / `SdgbJobService` 等服务执行管理操作。
- 直接读取多个 Mongo model，用于 dashboard、job 搜索、趋势、错误统计和指标聚合。

### `AuthModule`

- 负责签发和校验 JWT，`AuthGuard` 从 `Authorization: Bearer <jwt>` 解析当前用户。
- `AuthService` 创建好友请求登录 job，轮询登录状态，并在登录 job 满足条件后签发 token。
- `QrLoginService` 处理机台二维码登录：扫码、fast path 查已绑定 `cabinetUserId`，或通过 bot 加 rival + 好友快照反查用户。
- 持有 `qr_login_attempts`，记录 QR 登录异步流程状态。

### `AutoUpdateModule`

- 定时扫描开启 `autoUpdate` 且已绑定 `cabinetUserId` 的用户。
- 通过 `SdgbJobDispatcher.getRivalHash()` 检查机台成绩 hash；hash 未变则跳过，变化则创建 `update_score` job。
- 处理 hash check 节流、job 创建节流、in-flight job 跳过和失败退避。
- 提供管理后台手动 sweep、按好友码强制触发、开启用户列表、用户自动更新历史和开启人数统计。
- 持有 `auto_update_runs`，记录每轮自动更新执行摘要。

### `BotsModule`

- 接收 DXNet worker 上报的 bot 状态，维护 bot 是否可用、好友数量、最近好友快照时间、备注和 `cabinetUserId`。
- 根据状态变化发送飞书告警，包括单个 bot 不可用、全部 bot 不可用和恢复可用。
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

- 管理 DXNet worker 任务，任务类型包括 `send_friend_request`、`accept_friend_request`、`update_score` 和 `get_user_recent_event`。
- 创建 job 时会取消同一好友码的旧活跃 job，并按任务类型设置初始 stage。
- 为 worker 提供长轮询 claim：分配新 queued job、恢复本 bot 的 processing job、处理 `runAt` 延迟、释放 stale claim、超时失败。
- 处理 worker PATCH 回写的状态、stage、进度、profile、result、error 和执行标记。
- job 成功完成后会触发 `SyncService.createFromJob()` 写入同步成绩，并按用户设置执行自动导出。
- 支持机台绑定用户的 cabinet fast path：通过 sdgb 加 rival、使用 cabinet score map 优化 `update_score`，在 `cabinetOnlyMode` 下可短路为纯机台数据同步。
- `JobTempCacheService` 用 Redis 临时缓存 `update_score` 中间 FriendVS 解析结果。
- `JobApiLogService` 用 Redis 保存 worker 外部 API 调用 metadata，供调试页面查看。

### `MusicModule`

- 持有曲库数据 `musics` 和曲库来源配置 `music_config`。
- 支持 `diving-fish` / `lxns` 两种曲库数据源，并把外部 payload 转换为内部统一的 `MusicEntity`。
- 启动时注册曲库同步 cron，表达式来自 `MUSIC_SYNC_CRON`，默认每 6 小时。
- `findAll()` 使用 Nest cache 缓存完整曲库列表，曲库同步后清除缓存。
- 管理后台可读取和修改当前曲库来源，并手动触发曲库同步。

### `ScoreExportModule`

- 根据最新同步成绩和曲库数据生成图片，输出 `image/png`。
- 支持 Best 50、指定等级成绩图、按版本/牌子计划成绩图。
- 使用 `CoverService` 加载本地封面，使用用户 profile 渲染头部信息。
- `score-export.buckets.ts` 负责分桶、B50 汇总、等级/版本排序；`rendering/` 负责 canvas 渲染、字体和本地素材加载。
- 还提供按好友码批量生成导出图片的能力，供脚本或后续自动化使用。

### `SdgbWorkerModule`

- 管理 sdgb-worker 使用的机台协议任务，任务类型包括 `scan_qr`、`get_rival_hash` 和 `add_rival`。
- `SdgbJobService` 负责入队、FIFO claim、worker PATCH、等待完成、管理后台状态和分页查询。
- worker 每次 claim 会写 Redis 心跳，用于后台展示 worker 存活状态和 claim 计数。
- 会释放 stale processing job、失败超时 queued job，并通过 Mongo TTL 清理历史 job。
- `SdgbJobDispatcher` 把“入队 + 等待完成 + 返回 result”封装成同步调用，供登录、机台绑定、自动更新和 bot 绑定使用。

### `SyncModule`

- 将 DXNet worker 的 job result 或 cabinet score map 转换为 `SyncScore`，写入最新同步快照。
- 同一用户只保留最新 sync；新成绩会和上一份 sync 合并，避免部分难度抓取时丢失旧成绩。
- 合并策略保留更高的 achievement、dxScore、FC 和 FS，元数据来自最新曲库。
- 对外提供当前用户最新同步成绩查询。
- `ProberExportMapService` 缓存 Diving Fish 与 LXNS 的曲目 id 映射，支持在不同曲库来源下导出。
- 支持把最新 sync 上传到 Diving Fish 或 LXNS，并记录自动导出结果。

### `SystemSettingsModule`

- 管理全局系统设置集合 `system_settings`。
- 当前设置项为 `cabinetOnlyMode`，影响自动更新创建 `update_score` job 时是否允许 cabinet-only short circuit。
- `SystemSettingsService.get()` 有 5 秒内存缓存，减少 `JobService.create()` 热路径上的 Mongo 查询。
- 修改设置后会立即失效本实例缓存。

### `UsersModule`

- 管理用户主数据：好友码、导入 token、DXNet profile、最近活跃时间、偏好 bot、机台绑定和自动更新字段。
- `UsersService` 提供用户查找、创建、更新、批量 profile patch、自动更新节流/claim、失败退避和活跃状态查询。
- `CabinetService` 处理机台二维码绑定：解码 QR、调用 sdgb 扫码、用最新 sync 与机台成绩做身份匹配。
- `AccountDeletionService` 删除账号时同步清理该用户的 sync 和 job 数据。
- 其他模块通常通过好友码读取用户，通过用户 `_id` 更新设置。

### `WorkerLogsModule`

- 接收 dxnet/sdgb worker 批量上报的控制台日志。
- 日志写入 Redis Stream：`logs:worker:dxnet` / `logs:worker:sdgb`，按 `WORKER_LOG_STREAM_MAXLEN` 限长。
- 支持按 worker 类型、workerId、level、关键字、时间窗口过滤日志。
- 提供最近出现过的 workerId 列表，供管理后台筛选。
- 提供按时间桶统计包含特定文本的日志数量，供限流等指标使用。

## 常见修改定位

| 需求类型                         | 优先查看模块                                  |
| -------------------------------- | --------------------------------------------- |
| 登录、JWT、好友请求登录、QR 登录 | `AuthModule`、`JobModule`、`SdgbWorkerModule` |
| 用户资料、导入 token、机台绑定   | `UsersModule`、`SyncModule`                   |
| 手动更新成绩、worker 任务调度    | `JobModule`、`BotsModule`                     |
| 自动更新、hash 检查、失败退避    | `AutoUpdateModule`、`UsersModule`、`JobModule` |
| 曲库同步、曲库来源切换           | `MusicModule`                                 |
| 封面同步和封面静态返回           | `CoverModule`                                 |
| 成绩图导出                       | `ScoreExportModule`、`SyncModule`、`CoverModule` |
| sdgb-worker 机台协议任务         | `SdgbWorkerModule`                            |
| 管理后台统计和运维动作           | `AdminModule` 以及被调用的具体业务模块        |
| worker 日志与调试信息            | `WorkerLogsModule`、`JobApiLogService`        |
