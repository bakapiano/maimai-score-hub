# Diving-Fish / LXNS 成绩导出流程

本文档根据当前代码实现整理，范围覆盖用户手动导出、DXNet `update_score` 后自动导出、Rival-first 自动更新写入后的自动导出，以及 FC/FS enrichment 更新后的自动导出。代码中目标平台命名为 **Diving-Fish** 和 **LXNS**；“lynx”在本文中按当前代码事实对应为 `lxns` / 落雪查分器。

## 关键结论

- **导出任务统一落库**：`prober_export_jobs` 是导出任务与完整结果的 source of truth。
- **导出统一异步执行**：手动导出和自动导出都只创建 MongoDB task + BullMQ job；backend 内嵌 `ProberExportWorkerService` 消费 `prober-export-jobs`。
- **有 token 就自动导出**：用户保存 `divingFishImportToken` / `lxnsImportToken` 后，对应查分器默认参与同步后自动导出；不再需要 `autoExportDivingFish` / `autoExportLxns` 开关。
- **异步导出按 `syncId` 固定快照**：导出 job 保存 `syncId`，worker 后续执行时导出该 sync，而不是执行时的 latest sync。
- **不再写旧 job 字段**：`jobs.autoExportResult` 已移除；自动导出只把简化结果缓存到 `syncs.autoExportResult`，完整结果查 `prober_export_jobs.result`。

## 相关代码入口

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 前端 | `frontend\src\pages\SyncPage.tsx` | 配置 token、创建手动导出 job、轮询导出结果、展示自动导出结果 |
| 合约 | `shared\src\modules\sync\sync.schema.ts` | latest sync、导出 job、导出创建响应 schema |
| 合约 | `shared\src\modules\sync\sync.contract.ts` | 手动导出创建接口和导出 job 查询接口 |
| 用户入口 | `backend\src\api\me\me.controller.ts` | `PATCH /me` 保存 token，`POST /me/prober-tokens/diving-fish` 获取水鱼 token |
| 同步入口 | `backend\src\api\me\me-sync.controller.ts` | 创建手动导出 job、查询导出 job、查询 latest sync |
| 导出模块 | `backend\src\modules\prober-export\**` | 导出 job schema、enqueue service、backend 内嵌 BullMQ worker |
| 导出服务 | `backend\src\modules\sync\services\sync.service.ts` | 按 latest 或指定 `syncId` 转换并上传成绩 |
| 自动触发 | `backend\src\modules\job\services\job.service.ts` | DXNet `update_score` 和 FC/FS enrichment 完成后 enqueue |
| 自动触发 | `backend\src\modules\auto-update\services\auto-update-scheduler.service.ts` | Rival-first 写入 sync 后 enqueue |
| ID 映射 | `backend\src\modules\sync\services\prober-export-map.service.ts` | 构建并缓存 Diving-Fish ↔ LXNS 曲目 id map |
| 外部 API | `backend\src\common\prober\diving-fish\api.ts` | Diving-Fish 登录、import token、成绩上传 |
| 外部 API | `backend\src\common\prober\lxns\client.ts` | LXNS 成绩上传 |

## 用户配置与 token

用户表当前保留两个与导出直接相关的 token 字段：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `divingFishImportToken` | `null` | Diving-Fish `Import-Token`；存在即自动导出到 Diving-Fish |
| `lxnsImportToken` | `null` | LXNS `Personal Token`；存在即自动导出到 LXNS |

`GET /api/v1/me` 不返回 token 原文，只返回 `hasDivingFishImportToken` / `hasLxnsImportToken`。`PATCH /api/v1/me` 可更新 token；保存 token 时当前实现只写入数据库，不预校验外部平台 token 是否有效。

### Diving-Fish import token 获取

前端支持两种水鱼配置方式：

1. 直接手填 `Import Token`。
2. 输入 Diving-Fish 用户名和密码，调用 `POST /api/v1/me/prober-tokens/diving-fish`。

后端 `getImportToken()` 当前流程：

1. `POST https://www.diving-fish.com/api/maimaidxprober/login` 登录。
2. 从 `Set-Cookie` 提取 `jwt_token`。
3. `GET /player/profile` 查询 profile。
4. 如果 profile 已有 `import_token`，直接返回。
5. 如果没有，`PUT /player/import_token` 生成新 token，再重新查询 profile。

用户名和密码只用于这次 token 换取，后端不保存；前端获取成功后清空输入框，再 `PATCH /me` 保存 import token。

### LXNS token 获取

当前没有 LXNS 账号登录或 token 换取接口。前端只提供 `Personal Token` 输入框，保存到 `lxnsImportToken` 后，后续同步会默认自动导出到 LXNS。

## `prober_export_jobs` 数据模型

核心字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 导出任务 id |
| `trigger` | `dxnet_update_score`、`auto_update_rival`、`auto_update_fcfs`、`manual` |
| `friendCode` | 用户好友码 |
| `syncId` | 要导出的固定 sync 快照 |
| `sourceJobId` | DXNet job 来源，可为 `null` |
| `sourceTaskId` | auto-update task 来源，可为 `null` |
| `targets` | `divingFish` / `lxns` 数组 |
| `status` | `queued`、`processing`、`completed`、`partial_failed`、`failed`、`skipped` |
| `attempts` | worker claim 次数 |
| `result` | 每个 provider 的完整导出结果 |
| `error` | job 级错误 |
| `claimedAt` / `completedAt` | worker claim / 完成时间 |

自动导出的 idempotency 由唯一索引保证：

- `{ trigger, sourceJobId }`，仅 `sourceJobId` 为字符串时生效。
- `{ trigger, sourceTaskId }`，仅 `sourceTaskId` 为字符串时生效。

手动导出每次点击都创建新的 `manual` job。

## 手动导出流程

前端手动点击“更新”时：

1. 先 `PATCH /api/v1/me` 保存当前输入的 token。
2. 调用对应导出创建接口：

```http
POST /api/v1/me/sync/latest/exports/diving-fish
Authorization: Bearer <jwt>
```

```http
POST /api/v1/me/sync/latest/exports/lxns
Authorization: Bearer <jwt>
```

3. 后端校验当前用户是否保存了对应 token。
4. 后端读取当前 latest sync id，创建 `trigger="manual"` 的 `prober_export_jobs`，并加入 BullMQ。
5. 接口返回：

```json
{
  "exportJobId": "...",
  "status": "queued",
  "job": {}
}
```

6. 前端轮询：

```http
GET /api/v1/me/prober-export-jobs/:exportJobId
Authorization: Bearer <jwt>
```

直到 `completed` / `partial_failed` / `failed` / `skipped`。

手动导出结果不写入 `syncs.autoExportResult`，避免覆盖“同步后自动导出”的展示状态。

## 自动导出触发点

### DXNet `update_score`

`JobService.patch()` 在 worker 把 `update_score` PATCH 为 `completed` 且有 `result` 时：

1. `SyncService.createFromJob()` 写入最新 sync。
2. 调用 `ProberExportService.enqueueAutoExportForSync()`。
3. trigger 为 `dxnet_update_score`，source 为 `sourceJobId=jobId`。
4. service 根据用户现有 token 自动决定 targets。

### Rival-first 自动更新

`AutoUpdateSchedulerService.processRivalProbe()` 在 rival hash 变化并成功 `createFromRivalMusic()` 后：

1. 创建或替换用户最新 sync。
2. enqueue prober export。
3. trigger 为 `auto_update_rival`，source 为 `sourceTaskId=taskId`。

### FC/FS enrichment

`get_user_recent_event` job 完成后，`JobService.patch()` 调用 `SyncService.mergeRecentEvents()`。

只有当：

- `context.autoUpdateFcfs === true`
- `mergeResult.updatedCount > 0`
- `mergeResult.syncId` 存在

才 enqueue 导出；trigger 为 `auto_update_fcfs`，source 为 `sourceJobId=jobId`。

## Worker 执行流程

`ProberExportWorkerService` 在 backend 进程内启动 BullMQ worker，消费 `prober-export-jobs` 队列。

处理流程：

1. 根据 `{ jobId }` 原子 claim `queued` job 为 `processing`。
2. 重新读取用户 token；如果 token 已被删除，对应 provider 标记 failed。
3. 对每个 target 调用 exact-sync 导出：
   - `SyncService.exportSyncToDivingFish({ friendCode, syncId, importToken })`
   - `SyncService.exportSyncToLxns({ friendCode, syncId, importToken })`
4. 每个 provider 独立捕获异常并写入 `result`。
5. 聚合 job 状态：
   - 全成功：`completed`
   - 全 skipped：`skipped`
   - 全失败：`failed`
   - 成功/失败混合：`partial_failed`
6. 自动导出 job 会镜像简化结果到 `syncs.autoExportResult`；不会再写 `jobs.autoExportResult`。

`ProberExportService` 还有 interval sweep：释放 stale `processing` 锁，并把 `queued` job 补回 BullMQ。

## ID 映射

`ProberExportMapService` 负责把本地 sync score 的 `musicId` 映射到导出平台可识别的 id。缓存 TTL 为 6 小时。

构建流程：

1. 并发请求：
   - Diving-Fish 曲库：`https://www.diving-fish.com/api/maimaidxprober/music_data`
   - LXNS 曲库：`https://maimai.lxns.net/api/v0/maimai/song/list`
2. `buildDivingFishDocs()` 把水鱼曲库转换成统一 `MusicDoc`。
3. `buildLxnsDocs()` 把 LXNS 曲库转换成统一 `MusicDoc`；同一首歌同时有 standard 和 dx 谱时拆成两个 doc。
4. `buildIdMap()` 以 `title + type + category` 组成 key 做匹配，并应用少量硬编码 key override。

因为当前本地曲库来源固定为 Diving-Fish，Diving-Fish 导出主要使用原 id 和标题；LXNS 导出依赖 `toLxnsId`，没有匹配到的成绩会被跳过。

## 外部上传规则

### Diving-Fish

上传到：

```http
POST https://www.diving-fish.com/api/maimaidxprober/player/update_records
Content-Type: application/json
Import-Token: <divingFishImportToken>
```

payload 由 `convertSyncScoresToDivingFishRecords()` 生成，包含 `achievements`、`dxScore`、`fc`、`fs`、`level_index`、`title`、`type`。

重试规则：

- 长退避：`0s → 15s → 60s → 240s`。
- 网络错误和 5xx retry。
- 4xx 立即失败。
- `500 + 默认 HTML 500 页面` 被视为 degraded success，因为当前代码认为 Diving-Fish 已写库但响应渲染失败。

### LXNS

上传到：

```http
POST https://maimai.lxns.net/api/v0/user/maimai/player/scores
Content-Type: application/json
X-User-Token: <lxnsImportToken>
```

payload 由 `convertSyncScoresToLxnsPayload()` 生成。`fs` 会转换：`fdxp → fsdp`、`fdx → fsd`、`fsp/fs` 原样；`dx_star` 当前固定为 `0`。

重试规则同 Diving-Fish：网络错误和 5xx retry，4xx 立即失败。

## 当前实现注意点

- queue worker 嵌在 backend 进程内；多副本 backend 会各自启动 worker，但 MongoDB claim 保证同一 job 只处理一次。
- 自动导出按 token 存在性决定目标；历史 DB 中的 `autoExportDivingFish` / `autoExportLxns` 字段已不参与逻辑。
- 手动导出是 breaking change：接口不再直接返回外部平台 response，而是返回 `exportJobId`。
- `syncs.autoExportResult` 只反映自动导出的简化结果；完整结果查 `prober_export_jobs.result`。
- `ProberExportMapService` 构建失败会导致本次导出失败；当前没有使用旧缓存兜底。
