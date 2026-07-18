# 非自动更新 update_score Job 流程

本文档整理非 scheduler `update_score` 主流程。抓取/job 基线以当前代码为准；current sync
CAS 与 Prober Export 部分按[成绩更新目标规范](../score-updates/README.md)描述。

## 关键结论

- **`update_score` 是唯一会写入成绩的 DXNet job 类型**：只有 `jobType="update_score"` 且 job `completed` 且有 `result` 时，后端才会写入 `syncs`。
- **前端会先确认好友关系 / 机台绑定状态，再创建 `update_score`**：如果当前用户已是可用 Bot 好友，或已绑定 `cabinetUserId`，前端会直接创建 `update_score`；否则才先走好友关系建立流程。
- **后端不会把 `update_score` 自动改写成好友申请 job**：创建 `update_score` 时如果仍无法确认好友关系，会返回 `code: "needs_friendship"`。
- **Job 状态以 MongoDB `jobs` 集合为准**：BullMQ 只负责分发 `{ jobId }`。
- **“同步后自动导出”不是“自动更新”**：score version 增加后只唤醒统一导出执行器；
  `prober_export_states` 与 `syncs.__v` 的版本差决定是否需要上传到 Diving-Fish/LXNS。

## 相关代码入口

| 层             | 文件                                                | 作用                                                           |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| 前端           | `frontend/src/pages/SyncPage.tsx`                   | 查询好友状态、创建 `update_score`、轮询进度                    |
| 前端 API       | `frontend/src/api/jobClient.ts`                     | 调用 `/api/v1/me/dxnet-jobs*` ts-rest 接口                     |
| 合约           | `shared/src/modules/job/job.contract.ts`            | 定义用户端、worker 端 job API                                  |
| 合约           | `shared/src/modules/job/job.schema.ts`              | 定义 job status / stage / type / response                      |
| 后端入口       | `backend/src/api/me/me-dxnet-jobs.controller.ts`    | 当前用户创建、查询、唤醒自己的 DXNet job                       |
| 后端服务       | `backend/src/modules/job/services/job.service.ts`   | 创建 job、好友关系校验、派发 BullMQ、状态 PATCH、完成后写 sync |
| Worker         | `worker/src/worker/worker.ts`                       | BullMQ consumer，领取 `jobId` 后拉取 job 并执行                |
| Worker handler | `worker/src/worker/jobs/handlers/update-score/**`   | `update_score` 的实际 Friend VS 抓取与聚合                     |
| 成绩写入       | `backend/src/modules/sync/services/sync.service.ts` | 把 `update_score` result 映射并合并到最新 sync                 |

## update_score 数据字段

| 字段                  | 含义                                                      |
| --------------------- | --------------------------------------------------------- |
| `jobType`             | 固定为 `update_score`                                     |
| `stage`               | 固定为 `update_score`                                     |
| `status`              | `queued`、`processing`、`completed`、`failed`、`canceled` |
| `botUserFriendCode`   | 负责抓取这个用户成绩的 Bot 好友码                         |
| `runAt`               | 下次允许派发时间；`update_score` 正常情况下为 `null`      |
| `scoreProgress`       | 成绩抓取阶段的难度进度                                    |
| `updateScoreDuration` | worker 抓取耗时                                           |
| `result`              | worker 聚合后的 Friend VS 成绩结果                        |

## 创建前置：确认好友关系

用户点击“开始同步”或“更新数据”时，前端先调用：

```http
GET /api/v1/me/dxnet-jobs/friendship
Authorization: Bearer <token>
```

后端基于 Bot 状态和 `bot_statuses.friends` 判断当前用户是否已经存在于某个可用 Bot 的好友列表中，返回：

```json
{
  "isFriend": true,
  "hasCabinetUserId": true,
  "botFriendCode": "336560109012350",
  "recommendedBotFriendCode": "336560109012350",
  "availableBotCount": 3,
  "friendsUpdatedAt": "2026-06-26T12:00:00.000Z",
  "checkedAt": "2026-06-26T12:00:01.000Z"
}
```

`hasCabinetUserId` 只暴露布尔值，不暴露具体机台 ID。

前端判断：

1. `isFriend=true`：直接创建 `update_score`。
2. `hasCabinetUserId=true`：也直接创建 `update_score`，让后端在创建 job 时通过 cabinet fast-path 调 sdgb `addRival` 恢复好友关系。
3. 两者都为 false：先创建 `send_friend_request` 好友关系 job；该前置流程完成后，再用刚完成的 `friendshipJobId` 创建 `update_score`。

如果第 2 种情况下 sdgb `addRival` 失败，后端创建 `update_score` 会返回 `code: "needs_friendship"`，前端 fallback 到 `send_friend_request`。

## 创建 update_score

已确认好友关系时：

```http
POST /api/v1/me/dxnet-jobs
Authorization: Bearer <token>

{
  "jobType": "update_score"
}
```

刚完成好友关系前置流程、但 Bot 好友快照可能还没上报时：

```http
POST /api/v1/me/dxnet-jobs
Authorization: Bearer <token>

{
  "jobType": "update_score",
  "friendshipJobId": "<刚完成的好友关系 job id>"
}
```

后端创建前会再次确认好友关系：

1. 如果用户绑定了 `cabinetUserId`，先尝试 sdgb `addRival`。成功则认为好友关系已准备好。
2. 否则在可用 Bot 的好友快照中查找当前用户。
3. 如果提供了 `friendshipJobId`，后端验证它属于同一 `friendCode`、`jobType=send_friend_request`、`status=completed`、带 `botUserFriendCode` 且未过期，并把它作为短期好友关系证明。
4. 如果仍无法确认好友关系，返回 400：

```json
{
  "code": "needs_friendship",
  "message": "请先让当前账号与可用 Bot 成为好友后再更新成绩",
  "recommendedBotFriendCode": "..."
}
```

确认通过后，后端创建 MongoDB job：

```ts
{
  jobType: "update_score",
  stage: "update_score",
  status: "queued",
  botUserFriendCode: "<负责抓取的 bot>",
  runAt: null
}
```

然后把 `{ jobId }` 加入该 bot 的 BullMQ named queue：`dxnet-worker-jobs-<botUserFriendCode>`。

## 后端派发与超时保护

后端不再用 MongoDB dispatch sweep 补投递。`update_score` 创建时必须先解析出 `botUserFriendCode`，随后直接进入该 bot 的 named queue。BullMQ job 只包含 `{ jobId: string }`；如果 MongoDB job 有未来的 `runAt`，后端 enqueue 时会把它转换成 BullMQ delay。

## Worker 领取 update_score

`worker/src/worker/worker.ts` 中的 BullMQ worker：

1. 收到 BullMQ job 后，先调用后端 `GET /workers/dxnet/jobs/:jobId` 拉取完整 job。
2. 如果 job 已是终态，直接返回。
3. 如果 `runAt` 在未来，把 BullMQ job 延后到 `runAt`。
4. 如果当前没有可用 Bot 或 Bot cookie expired，把 BullMQ job 延后 5 秒。
5. 如果 job 缺失 `botUserFriendCode` 或被投递到错误 bot 的 queue，worker 将业务 job 标记为 `failed`。
6. 调用后端 PATCH 标记开始：`queued` 改成 `processing`、清空 `runAt`。
7. 创建 `JobHandler`，由 `updateScoreJobHandler` 执行。

`JobHandler` 有 30 分钟 worker 侧硬超时。普通 handler 抛错会把 job 标记为 `failed`；`CookieExpiredError` 不会直接失败 job，而是暂停该 bot 的 named queue consumer，等待 cookie 恢复或 stale-bot cleanup。

## Worker 抓取成绩

`updateScoreJobHandler` 只支持 `stage="update_score"`。

1. `prepareTargetProfile()` 先通过 maimai NET 查询目标 `friendCode` 的 profile；如果查不到，job 失败。
2. Worker 抓取默认 `DIFFICULTIES=[0,1,2,3,4,10]`，即 BASIC、ADVANCED、EXPERT、MASTER、Re:MASTER、宴会场。
3. 每个难度都会抓 `scoreType=1` 和 `scoreType=2`。
4. 每个 `scoreType` 都分别请求 Friend VS 的 `winOnly` 和 `loseOnly` 页面，然后合并去重，避免默认页面歌曲过多时截断漏歌。
5. Friend VS 抓取并发来自 `WORKER_DEFAULTS.friendVSConcurrency`，当前为 2。
6. 每完成一个难度，worker PATCH `addCompletedDiff`，前端进度条更新。
7. 全部完成后，worker PATCH：
   - `result=<聚合后的成绩>`
   - `status=completed`
   - `error=null`
   - `updateScoreDuration=<耗时>`

## 完成后的写入

Worker PATCH `update_score` 为 `completed` 后，`JobService.patch()` 会做以下后处理。

### 1. 清理临时缓存

当 job 进入 `completed`、`failed`、`canceled` 任一终态时，后端异步删除该 `jobId` 的临时缓存。

### 2. 写入 sync

只有满足以下条件才会写成绩：

- `updated.status === "completed"`
- `updated.jobType === "update_score"`
- `updated.result` 存在

`SyncService.createFromJob()` 将 worker 结果映射为 delta，通过统一 CAS 合并到 current sync，
保留更高的 dxScore/achievement/FC/FS。CAS 冲突时重新读取最新 current 后 merge，不再删除
旧 sync 并创建新文档。

### 3. 同步后自动导出

score version 实际增加后，`JobService` 只 best-effort 确保存在稳定的 per-user BullMQ wake。
即使 enqueue 丢失，定期 reconciliation 也会比较 provider `lastSuccessVersion` 与
`syncs.__v` 并补投。自动导出结果和版本游标保存在 `prober_export_states`；
`prober_export_jobs` 只记录实际 attempt，不再把结果镜像到 `syncs.autoExportResult`。

自动导出独立于 DXNet job 完成；前端从 export state 的安全投影展示 provider 进度，完整
attempt 结果通过 prober-export job 查询。详细状态机见
[Diving-Fish / LXNS 成绩导出规范](../prober-export/README.md)。

## 与自动更新 update_score 的区别

| 维度             | 非自动更新 `update_score`                             | 自动更新 `update_score`                                                  |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| 触发方           | 用户点击 `SyncPage` 按钮                              | `AutoUpdateSchedulerService` cron                                        |
| 创建入口         | `POST /api/v1/me/dxnet-jobs`                          | scheduler 内部调用 `JobService.create()`                                 |
| 用户条件         | 已登录，有 JWT friendCode                             | `autoUpdate=true` 且绑定 `cabinetUserId`                                 |
| hash 检查        | 不做 hash 比较                                        | Rival-first 自动更新由 `auto_update_probe_states.lastRivalHash` 判断变化 |
| 失败回退         | 返回 `needs_friendship`，由前端先完成好友关系前置流程 | 失败会计入自动更新 backoff                                               |
| 完成后 hash 推进 | 不涉及                                                | 成功后推进 `auto_update_probe_states.lastRivalHash`                      |

## 当前实现注意点

- `friendshipJobId` 是短期证明，当前有效期为 10 分钟。
- 创建新 job 时，后端仍会取消同一 `friendCode` 下未结束旧 job；但 `update_score` 的好友关系校验发生在取消旧 job 之前，避免校验失败时误取消正在跑的好友关系前置流程。
- `jobs` 集合有 7 天 TTL 索引，另有 admin cleanup 接口可删除 7 天前 job。
- BullMQ job 成功后会被移除；排查历史状态应看 MongoDB `jobs` 集合，而不是 BullMQ。
