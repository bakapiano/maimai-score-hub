# Backend API 总览

本文档整理 backend 当前对外暴露的 HTTP API。来源以 `backend/src/main.ts`、`backend/src/api/**/*.controller.ts` 和 `shared/src/modules/**/*.schema.ts` 为准。

## 基础约定

- 统一前缀：所有业务接口都挂在 `/api/v1` 下。表格中的路径省略此前缀，例如 `/health` 的完整路径是 `/api/v1/health`。
- Swagger UI：`/api/v1/swagger`，加载 `shared/openapi/openapi.yaml`。注意该 OpenAPI 文件由 shared ts-rest contracts 生成，不覆盖所有 controller-only 接口。
- CORS：`origin: true`。
- 请求体大小：JSON 和 urlencoded 均为 `100mb`。
- 业务端点数量：66 个，含 `/health`，不含 Swagger 静态资源。

## 路由分层

HTTP controller 统一放在 `backend/src/api` 下，按调用方分层；`backend/src/modules` 只承载业务 service、schema 和领域 helper。

| 前缀         | 调用方       | 说明                                                           |
| ------------ | ------------ | -------------------------------------------------------------- |
| `/auth/*`    | 未登录用户   | 登录请求、登录轮询、二维码登录。                               |
| `/me/*`      | 当前登录用户 | 当前用户资料、同步数据、成绩图导出、个人 DXNet job、机台绑定。 |
| `/catalog/*` | 公开访问     | 曲库和封面等公开只读资源。                                     |
| `/public/*`  | 公开访问     | 非当前用户语义的公开查询接口。                                 |
| `/workers/*` | 后台 worker  | DXNet worker、SDGB worker、worker 日志、bot 心跳。             |
| `/admin/*`   | 管理后台     | 管理统计、运维操作、worker/job/bot 调试入口。                  |

## 认证方式

| 标记          | Header                              | 说明                                                                                                  |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Public        | 无                                  | 公开接口。                                                                                            |
| User          | `Authorization: Bearer <jwt>`       | `AuthGuard` 校验 JWT；有效期由登录签发逻辑控制，目前为 30 天。                                        |
| Shared Secret | `X-API-Secret: <API_SHARED_SECRET>` | `SharedSecretGuard` 校验；Admin 和 Worker API 共用。后端未配置 `API_SHARED_SECRET` 时拒绝受保护接口。 |

## 通用与登录

| 方法 | 路径                                 | 认证   | 入参                                                                      | 说明                                                                                                                                       |
| ---- | ------------------------------------ | ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET  | `/health`                            | Public | -                                                                         | 健康检查，返回 `{ status: "ok" }`。                                                                                                        |
| GET  | `/statistics`                        | Public | -                                                                         | 通用公开统计。当前返回 `{ dxnetJobs }`，包含最近 DXNet job 总数、成功数、失败数、成功率、平均耗时。                                        |
| POST | `/auth/login-requests`               | Public | body: `friendCode`, `method: "bot_sends_request" \| "user_sends_request"` | 创建好友请求登录 job。`SKIP_AUTH=true` 时直接返回 token。                                                                                  |
| GET  | `/auth/login-requests/:jobId`        | Public | path: `jobId`                                                             | 查询登录 job 状态；`completed` 或 `accept_friend_request` 进入 `accept_request` 后返回 token、user。                                       |
| POST | `/auth/login-requests/:jobId/verify` | Public | path: `jobId`                                                             | 唤醒或确认好友请求登录 job，返回 `{ job }`。                                                                                               |
| POST | `/auth/qr-login`                     | Public | JSON body: `qrCode?`，或 multipart field: `image`，也可同时带 `qrCode`    | 机台二维码登录。已绑定用户走 fast path 返回 token/user；新用户返回 `{ kind: "async", attemptId }`。二维码过期时返回 `code: "qr_expired"`。 |
| GET  | `/auth/qr-login/:attemptId`          | Public | path: `attemptId`                                                         | 轮询二维码登录慢路径。状态为 `pending`、`adding_rival`、`waiting_snapshot`、`matched` 或 `failed`；成功时带 token/user。                   |
| POST | `/auth/password-login`               | Public | body: `friendCode` 或 `username`，加 `password`                           | 密码登录。只有已设置密码的既有用户可用，成功返回 token/user。                                                                              |

## 当前用户

以下接口均需要 User 认证。

| 方法   | 路径                            | 入参                                                              | 说明                                                                                                                                       |
| ------ | ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/me`                           | -                                                                 | 返回当前用户资料。不会暴露 import token 或原始 `cabinetUserId`，只返回 `has*` 布尔标记。                                                   |
| PATCH  | `/me`                           | body: `divingFishImportToken?`, `lxnsImportToken?`, `autoUpdate?` | 更新导入 token 和自动更新开关。保存 token 后同步完成会默认自动导出到对应查分器；开启自动更新前必须已绑定机台二维码；返回脱敏后的用户资料。 |
| PUT    | `/me/password`                  | body: `username?`, `currentPassword?`, `newPassword?`             | 已登录用户设置/修改用户名和密码。已有密码时需要 `currentPassword`。                                                                        |
| POST   | `/me/prober-tokens/diving-fish` | body: `username`, `password`                                      | 用 Diving Fish 账号密码一次性获取 import token；用户名密码不保存。                                                                         |
| PUT    | `/me/cabinet`                   | JSON body: `qrCode?`，或 multipart field: `image`                 | 绑定机台 `cabinetUserId`。要求账号尚未绑定，并且已完成过成绩同步；匹配失败返回 409。                                                       |
| DELETE | `/me/cabinet`                   | -                                                                 | 解绑机台 userId，并关闭自动更新。                                                                                                          |
| DELETE | `/me`                           | -                                                                 | 删除当前账号及相关数据，返回删除统计。                                                                                                     |

## 同步与成绩导出

以下接口均需要 User 认证。

| 方法 | 路径                                  | 入参                                    | 说明                                                                                        |
| ---- | ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET  | `/me/sync/latest`                     | -                                       | 返回当前用户最近一次同步记录和 scores，可能为 `null`。                                      |
| POST | `/me/sync/latest/exports/diving-fish` | -                                       | 创建异步 Diving Fish 导出任务，返回 `exportJobId`。要求用户已保存 `divingFishImportToken`。 |
| POST | `/me/sync/latest/exports/lxns`        | -                                       | 创建异步 LXNS 导出任务，返回 `exportJobId`。要求用户已保存 `lxnsImportToken`。              |
| GET  | `/me/sync/prober-export-jobs/:exportJobId` | path: `exportJobId`                     | 查询当前用户自己的查分器导出任务结果。                                                      |
| GET  | `/me/sync/prober-export-jobs`              | query: `limit?`                         | 查询当前用户最近的查分器导出任务。                                                          |
| GET  | `/me/score-exports/best50`            | -                                       | 生成 Best 50 PNG，响应 `Content-Type: image/png`，下载名 `best50.png`。                     |
| GET  | `/me/score-exports/level`             | query: `level?`                         | 按等级生成成绩 PNG，下载名 `level-<level>.png`。                                            |
| GET  | `/me/score-exports/version`           | query: `version?`, `minLevel?`, `plan?` | 按版本/牌子计划生成成绩 PNG。`plan` 支持 `jiang`、`ji`、`wuwu`、`shen`，非法值按 `jiang`。  |

## DXNet Job

### 用户侧

以下接口均需要 User 认证。

| 方法 | 路径                           | 入参                                                                           | 说明                                                                                                                                 |
| ---- | ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| POST | `/me/dxnet-jobs`               | body: `jobType? = "update_score" \| "send_friend_request"`, `friendshipJobId?` | 为当前用户创建成绩更新或好友关系 job；好友码从 JWT 中读取。创建 `update_score` 时若未确认好友关系会返回 `code: "needs_friendship"`。 |
| GET  | `/me/dxnet-jobs/friendship`    | -                                                                              | 基于 Bot 好友列表快照判断当前用户是否已和可用 Bot 成为好友，返回推荐 Bot；对已绑定机台的用户只返回 `hasCabinetUserId: true`，不暴露具体机台 ID。 |
| GET  | `/me/dxnet-jobs/active`        | -                                                                              | 查询当前用户正在排队或处理中的成绩更新相关 job，返回 `{ job }`。                                                                     |
| GET  | `/me/dxnet-jobs/:jobId`        | path: `jobId`                                                                  | 按 id 查询当前用户自己的 job 详情。                                                                                                  |
| POST | `/me/dxnet-jobs/:jobId/verify` | path: `jobId`                                                                  | 用户声明已完成外部动作，请后端立即验证当前用户自己的 job，返回 `{ job }`。                                                           |

## 曲库与封面

| 方法 | 路径                  | 认证   | 入参       | 说明                                                                                                               |
| ---- | --------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| GET  | `/catalog/music`      | Public | -          | 返回当前曲库列表。                                                                                                 |
| GET  | `/catalog/covers/:id` | Public | path: `id` | 返回本地封面图片。根据 `Accept: image/webp` 优先选择 webp；设置长缓存；找不到返回 404。`id` 可以包含 `.jpg` 后缀。 |

## Worker API

以下接口均需要 Shared Secret 认证。

### DXNet Worker

| 方法  | 路径                                                         | 入参                                                                                                                                   | 说明                                                                                                      |
| ----- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET   | `/workers/dxnet/bots/:botUserFriendCode/active-friend-codes` | path: `botUserFriendCode`                                                                                                              | 查询指定 bot 当前活跃 job 覆盖的好友码列表。                                                              |
| GET   | `/workers/dxnet/jobs/:jobId`                                 | path: `jobId`                                                                                                                          | worker 按 id 获取 job。                                                                                   |
| PATCH | `/workers/dxnet/jobs/:jobId`                                 | body: `status?`, `stage?`, `result?`, `profile?`, `error?`, `runAt?`, `scoreProgress?`, `addCompletedDiff?`, `updateScoreDuration?` 等 | worker 更新 job 状态、阶段、进度、结果或错误。`get_user_recent_event` 完成后后端会把 events 合并进 sync。 |
| POST  | `/workers/dxnet/users/activity`                              | body: `friendCodes: string[]`                                                                                                          | 批量查询用户最近活跃时间和机台绑定状态，返回 `{ friendCode, lastActiveAt, cabinetUserId }[]`。            |
| GET   | `/workers/dxnet/jobs/:jobId/cache/:diff/:type`               | path: `jobId`, `diff`, `type`                                                                                                          | 读取 `update_score` 临时缓存的 FriendVS 解析结果。缺失返回 400。                                          |
| PUT   | `/workers/dxnet/jobs/:jobId/cache/:diff/:type`               | body: `songs: FriendVsSong[]`                                                                                                          | 写入临时缓存，返回 `{ success: true }`。                                                                  |
| POST  | `/workers/dxnet/jobs/:jobId/api-calls`                       | body: `calls: ExternalApiCallEntry[]`                                                                                                  | worker 上报某 job 的外部 API metadata，写入 ClickHouse `external_api_calls`。                              |
| POST  | `/workers/:kind/external-api-calls`                          | path: `kind`; body: `calls: ExternalApiCallEntry[]`                                                                                    | worker 上报非 job 绑定或通用外部 API metadata，供 sdgb-worker 等服务接入 ClickHouse。                       |

### SDGB Worker

| 方法  | 路径                           | 入参                                 | 说明                                          |
| ----- | ------------------------------ | ------------------------------------ | --------------------------------------------- |
| POST  | `/workers/sdgb/jobs/heartbeat` | body: `workerId`, `claimedDelta?`    | BullMQ 版 sdgb-worker 上报心跳和领取计数。    |
| GET   | `/workers/sdgb/jobs/:jobId`    | path: `jobId`                        | BullMQ sdgb-worker 按 id 查询 sdgb job 详情。 |
| PATCH | `/workers/sdgb/jobs/:jobId`    | body: `status?`, `result?`, `error?` | sdgb-worker 回写 job 状态、结果或错误。       |

### Worker 日志与 Bot 心跳

| 方法 | 路径                          | 入参                                                                                | 说明                                                                                         |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| POST | `/workers/logs/:kind/batches` | path: `kind = sdgb \| dxnet`; body: `workerId`, `entries: { ts, level, message }[]` | 批量上报 worker structured logs，写入 ClickHouse `structured_logs`，返回 `{ accepted }`。      |
| POST | `/workers/bots/status`        | body: `bots: BotStatusReport[]`                                                     | DXNet worker 上报 bot 状态、好友数和可选好友列表快照；返回 `{ ok: true }`。                  |

### 自动记录的外部依赖 metadata

| target | 来源 | apiGroup / urlGroup 示例 |
| --- | --- | --- |
| `maimai_dxnet` | DXNet worker 页面请求、OAuth / home 请求 | `maimai.friend.genre_vs`、`maimai.friend.pages`、`maimai.auth` |
| `diving_fish` | 登录 / profile / import token / 成绩上传 / 曲库 / 封面 | `diving_fish.login`、`diving_fish.update_records`、`diving_fish.music_data`、`diving_fish.cover` |
| `lxns` | 成绩上传 / 曲库映射 / 封面 | `lxns.upload_scores`、`lxns.song_list`、`lxns.cover` |
| `asset` | 成绩图渲染时远程头像 / icon / rank 图片 | `maimai.asset`、`diving_fish.asset`、`lxns.asset`、`remote.asset` |
| `sdgb` | 预留给 sdgb-worker 通过 `/workers/:kind/external-api-calls` 上报 | `sdgb.get_rival_music`、`sdgb.get_user_map`、`sdgb.add_rival` |

## Admin API

以下接口均需要 Shared Secret 认证。

### Dashboard

| 方法 | 路径                                     | 入参                                    | 说明                                         |
| ---- | ---------------------------------------- | --------------------------------------- | -------------------------------------------- |
| GET  | `/admin/dashboard/stats`                 | -                                       | 基础统计：用户数、曲目数、同步数、封面数等。 |
| GET  | `/admin/dashboard/job-stats`             | -                                       | job 聚合统计。                               |
| GET  | `/admin/dashboard/prober-export-metrics` | query: `window? = 24h \| 7d`            | 自动导出到 prober 的聚合指标；默认 `24h`。   |
| GET  | `/admin/dashboard/job-trend`             | query: `hours?`，范围 1 到 720，默认 24 | job 趋势数据。                               |
| GET  | `/admin/dashboard/job-error-stats`       | -                                       | job 错误统计。                               |

### 用户、任务与日志

| 方法 | 路径                          | 入参                                                         | 说明                                                    |
| ---- | ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| GET  | `/admin/users`                | -                                                            | 返回所有用户列表。                                      |
| GET  | `/admin/dxnet-jobs/active`    | -                                                            | 返回当前活跃 DXNet jobs。                               |
| GET  | `/admin/dxnet-jobs`           | query: `friendCode?`, `status?`, `page`, `pageSize` 最大 100 | 分页搜索 DXNet jobs。                                   |
| POST | `/admin/dxnet-jobs/cleanup`   | -                                                            | 清理 7 天前的 jobs，返回 `{ ok: true, deletedCount }`。 |
| GET  | `/admin/jobs/:jobId/debug`    | query: `env? = prod \| dev`                                  | Mongo job + ClickHouse timeline/API/logs 的组合调试视图。 |
| GET  | `/admin/history/logs`         | query: `env?`, `service?`, `workerKind?`, `workerId?`, `level?`, `q?`, `sinceMinutes?`, `limit?` | 查询 ClickHouse structured logs，前端入口为 `/admin/live-logs`。 |
| GET  | `/admin/history/log-workers`  | query: `env?`, `sinceMinutes?`                               | 返回 ClickHouse structured logs 中最近出现过的 workerId。 |

### 曲库与封面管理

| 方法 | 路径                                      | 入参 | 说明                                           |
| ---- | ----------------------------------------- | ---- | ---------------------------------------------- |
| POST | `/admin/catalog/covers/sync`              | -    | 增量同步封面，返回 `{ ok: true, ...result }`。 |
| POST | `/admin/catalog/covers/force-sync`        | -    | 强制同步封面，返回 `{ ok: true, ...result }`。 |
| POST | `/admin/catalog/covers/backfill-variants` | -    | 补齐封面变体，返回 `{ ok: true, ...result }`。 |
| POST | `/admin/catalog/music/sync`               | -    | 同步曲库数据，返回 `{ ok: true, ...result }`。 |

### Bot 管理

| 方法   | 路径                                      | 入参                                  | 说明                                                                           |
| ------ | ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/admin/bots`                             | -                                     | 返回全部 bot 状态。                                                            |
| PATCH  | `/admin/bots/:friendCode/remark`          | body: `remark: string \| null`        | 更新 bot 管理备注。                                                            |
| PATCH  | `/admin/bots/:friendCode/cabinet-user-id` | body: `cabinetUserId: number \| null` | 配置 bot 的机台 userId。                                                       |
| DELETE | `/admin/bots/:friendCode`                 | path: numeric `friendCode`            | 删除 bot 状态行；内嵌好友快照随状态行一起删除。worker 仍在线时下次心跳会重建。 |
| POST   | `/admin/bots/:friendCode/cabinet/bind-qr` | body: `qrCode: string`                | 通过 sdgb-worker 扫码绑定 bot 的 `cabinetUserId`。                             |

## OpenAPI 覆盖差异

`/api/v1/swagger` 使用 `shared/openapi/openapi.yaml`。该文件覆盖了 shared contracts 中定义的大部分用户、worker、admin 和 catalog 接口，但下列 controller-only 接口当前不在 generated OpenAPI 中，或实现比 contract 多：

- `POST /admin/bots/:friendCode/cabinet/bind-qr`
- `POST /workers/logs/:kind/batches`
- `GET /workers/dxnet/jobs/:jobId`
- `POST /workers/sdgb/jobs/heartbeat`
- `POST /auth/qr-login` 的 multipart `image` 上传形态
