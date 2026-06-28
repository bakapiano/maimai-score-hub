# DXNet Worker Job Pick 与执行流程

本文档根据当前代码实现整理 DXNet worker 如何通过 **per-bot named queue** pick job、如何执行业务 job，以及 worker 死亡 / 重启时 BullMQ 如何重新投递。

## 关键结论

- **每个 bot 一个 BullMQ 队列**：队列名为 `dxnet-worker-jobs-<botFriendCode>`。
- **worker 只消费自己的 bot 队列**：bot A 的 job 不会被 bot B 的 worker 正常拿到。
- **job 创建时必须绑定 `botUserFriendCode`**：不再存在“未绑定 job 进入公共队列后由 worker 抢占”的路径。
- **MongoDB 只保存业务状态**：`jobs.executing` 已移除，投递状态由 BullMQ 的 `waiting/delayed/active/stalled/failed/completed` 管理。
- **当前仍是 at-least-once 执行语义**：worker 死亡、lock 过期、stalled recovery 后，同一业务 job 可能再次执行。

## 相关代码入口

| 层                     | 文件                                                      | 作用                                                              |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| 队列常量               | `shared/src/common/worker-queues.ts`                      | 定义 `DXNET_WORKER_QUEUE_PREFIX` 和 `getDxnetWorkerQueueName()`   |
| 后端队列配置           | `backend/src/common/bullmq/bullmq.config.ts`              | Redis 连接、BullMQ prefix、默认 job options                       |
| 后端 job 服务          | `backend/src/modules/job/services/job.service.ts`         | 创建 job、分配 bot、按 bot queue enqueue、镜像 BullMQ failed 事件 |
| 后端 bot 选择          | `backend/src/modules/bots/services/bot-status.service.ts` | `pickAvailableBot()` / `pickAvailableCabinetBot()`                |
| 后端 worker API        | `backend/src/api/workers/worker-dxnet-jobs.controller.ts` | `GET/PATCH /workers/dxnet/jobs/:jobId`                            |
| Worker BullMQ consumer | `worker/src/worker/worker.ts`                             | 根据当前 bot 启停 named queue consumer                            |
| Worker job session     | `worker/src/worker/jobs/job-session.ts`                   | 封装 PATCH、stage transition、delay、fail、complete               |
| Worker watchdog        | `worker/src/worker/jobs/job-watchdog.ts`                  | 30 分钟 worker 侧硬超时                                           |
| Worker handler 入口    | `worker/src/worker/jobs/index.ts`                         | 调用不同 job type handler                                         |

## 当前关键参数

| 参数               |                          当前默认值 | 位置 / 来源                 | 含义                                           |
| ------------------ | ----------------------------------: | --------------------------- | ---------------------------------------------- |
| DXNet queue prefix |                 `dxnet-worker-jobs` | `DXNET_WORKER_QUEUE_PREFIX` | per-bot queue 前缀                             |
| Queue name         | `dxnet-worker-jobs-<botFriendCode>` | `getDxnetWorkerQueueName()` | 某个 bot 的专属队列                            |
| BullMQ lock        |             BullMQ 默认，通常 `30s` | 未显式配置 `lockDuration`   | worker active job 的 Redis lock                |
| BullMQ lock 续约   |             BullMQ 默认，通常 `15s` | 未显式配置 `lockRenewTime`  | active job 存活时自动续锁                      |
| 无可用 bot 重试    |                                `5s` | `BULLMQ_JOB_RETRY_DELAY_MS` | worker 暂不能执行时把 BullMQ job 延后          |
| Hard timeout       |                             `30min` | `TIMEOUTS.jobHardTimeout`   | worker 侧硬超时，best-effort 标记业务 job 失败 |

## `botUserFriendCode` 分配机制

后端创建 DXNet job 前会确定执行 bot，并把 `botUserFriendCode` 写入 MongoDB job。

| jobType                 | 分配策略                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `send_friend_request`   | `pickAvailableBot()`：选择 `available=true` 且 `friendCount + queued/processing in-flight` 最小的 bot |
| `accept_friend_request` | 登录入口预选 bot；未传时 `JobService.create()` 兜底调用 `pickAvailableBot()`                          |
| `update_score`          | 使用已有好友关系 bot、`friendshipJobId` 的 bot，或 cabinet fast-path 选中的 bot                       |
| `get_user_recent_event` | 调用方必须传 bot；自动更新 FC/FS enrichment 先用 `pickAvailableCabinetBot()`                          |
| `get_full_friend_list`  | 通常绑定到目标 bot 自己；未传时兜底使用 `friendCode` 作为 bot code                                    |

`pickAvailableCabinetBot()` 只选择 `available=true && cabinetUserId != null` 的 bot，并同样按 `friendCount + queued/processing in-flight` 最小排序。

用户侧 `/me/dxnet-jobs/friendship` 会返回 `hasCabinetUserId` 布尔值，但不会暴露具体 `cabinetUserId`。前端看到 `isFriend=true` 或 `hasCabinetUserId=true` 时会直接创建 `update_score` job；后端创建 job 时通过 cabinet fast-path 调用 sdgb `addRival` 恢复好友关系。如果 addRival 失败，创建 job 返回 `code: "needs_friendship"`，前端再 fallback 创建 `send_friend_request` job。

## 后端创建与入队

后端创建 MongoDB job 时，`botUserFriendCode` 必须非空：

```ts
{
  id,
  jobType,
  stage,
  status: "queued",
  botUserFriendCode: "<bot friend code>",
  runAt: null,
  createdAt: now,
  updatedAt: now
}
```

随后按 bot enqueue：

```ts
const queue = getDxnetQueue(job.botUserFriendCode);
await queue.add(
  "dxnet-job",
  { jobId: job.id },
  {
    jobId: job.id,
    delay,
    priority,
  },
);
```

BullMQ job 只包含 `{ jobId }`。业务状态、结果、错误、进度仍以 MongoDB `jobs` 集合为准。

## 后端不再做 dispatch sweep

旧实现会每 30 秒扫描 MongoDB：释放 `executing`、查找可投递 job、补进公共队列。当前实现已移除这条路径。

现在的投递 source of truth 是 BullMQ：

1. 创建 job 时直接进入对应 bot 的 named queue。
2. 等待类 stage 使用 BullMQ delayed。
3. worker 死亡后依赖 BullMQ lock / stalled recovery 重新投递。
4. backend `QueueEvents` 监听每个 bot queue 的 `failed` 事件，把 BullMQ 层最终失败镜像到 MongoDB job。

`BotStatusService.cleanupStaleJobs()` 仍会把分配给不可用 bot 的 `queued/processing` job 标记为 `failed`，这是业务清理，不参与正常投递调度。

## Worker pick 流程

DXNet worker 启动时读取当前 bot：

```ts
const queueName = getDxnetWorkerQueueName(bot.friendCode);
new BullMQWorker(queueName, processQueueJob, createBullmqWorkerOptions());
```

bot cookie 不存在或已过期时，worker 不启动 named queue consumer；cookie 恢复或替换时，worker 根据 bot state 关闭旧 consumer 并启动新 consumer。

每次 pick 到 BullMQ job 后，处理流程如下：

1. 校验 BullMQ `token` 存在。后续 `moveToDelayed()` / `moveToWait()` 需要这个 token 证明当前 worker 仍持有 lock。
2. `GET /api/v1/workers/dxnet/jobs/:jobId` 从 backend 拉取完整 MongoDB job。
3. 如果业务 job 已经是 `completed` / `failed` / `canceled`，直接返回，BullMQ job 完成并移除。
4. 如果 `runAt` 在未来，调用 `queueJob.moveToDelayed(runAt, token)`，抛 `DelayedError` 交给 BullMQ 控制流。
5. 如果当前没有 bot 或 bot cookie 已过期，把 BullMQ job 延后 `BULLMQ_JOB_RETRY_DELAY_MS`，默认 5 秒。
6. 如果 job 缺失 `botUserFriendCode`，或被投递到错误 bot 的 queue，worker 将业务 job 标记为 `failed`；这代表后端路由数据错误，不再做“拿错后延后 5 秒”的软路由。
7. PATCH backend 标记开始：`queued` 改成 `processing`，清空 `runAt`，更新 `updatedAt`。
8. 创建 `JobHandler` 并执行对应 job type handler。
9. handler 返回后，如果业务 job 仍非终态，则根据 `runAt` 延后，或 `moveToWait()` 回到同一个 bot queue。

## JobHandler 执行流程

`JobHandler.execute()` 包住所有具体业务 handler：

1. 启动 watchdog：30 分钟后触发 worker 侧 hard timeout，best-effort PATCH `status=failed`。
2. 调用 `prepareJob()`。不同 job type 可做前置 profile 查询等准备。
3. 调用 `executeJobByType()`，按 `jobType` 分发到：
   - `send_friend_request`
   - `accept_friend_request`
   - `update_score`
   - `get_user_recent_event`
   - `get_full_friend_list`
4. 如果 handler 抛普通错误，worker PATCH `status=failed` 和 `error`。
5. 如果遇到 `CookieExpiredError`，不直接 fail 业务 job，只打印日志；bot 会被标记 expired，named queue consumer 会被 graceful close，不再 pick 新 job。当前 active job 会继续跑完 handler，并用当前 BullMQ token `moveToWait()` 回到同一个 bot queue；如果进程在这之前被强杀，BullMQ lock 过期后按 stalled 机制重投递。
6. finally 中停止 watchdog、flush API logs。
7. 如果 job `completed` 且 `removeFriendAfterComplete=true`，worker 会 fire-and-forget 调用 `removeFriend(friendCode)`。这一步不 await，不阻塞 BullMQ job 完成；失败只记录 warning。

## 各 job type 的 stage 行为

| jobType                 | 主要 stage              | 执行结果                                                                      |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `send_friend_request`   | `send_request`          | 发送好友请求；已是好友则直接 `completed`，否则转 `wait_acceptance`            |
| `send_friend_request`   | `wait_acceptance`       | 检查用户是否已接受；未接受则 `runAt=now+30s`，同一个 bot queue delayed 后重试 |
| `accept_friend_request` | `wait_user_request`     | 等待用户主动发请求；没等到则 `runAt=now+30s`                                  |
| `accept_friend_request` | `accept_request`        | 接受好友请求后 `completed`                                                    |
| `update_score`          | `update_score`          | 抓 Friend VS 成绩，按难度更新进度，完成后 PATCH `result` 和 `completed`       |
| `get_user_recent_event` | `get_user_recent_event` | 抓最近游玩事件，完成后 PATCH `completed`                                      |
| `get_full_friend_list`  | `get_full_friend_list`  | 抓完整好友列表并刷新 bot snapshot，完成后 PATCH `completed`                   |

`ctx.delay(ms)` 只更新业务 job 的 `runAt` 和 `updatedAt`；handler 返回后，worker 会把 BullMQ job delay 到这个 `runAt`。因此等待类 stage 不会长时间占用 worker 并发。

自动更新触发的 DXNet job 会设置 `removeFriendAfterComplete=true`，避免 sdgb `addRival` 持续撑高 bot 好友数。`get_user_recent_event` 如果发现 FC/FS recent event 无法唯一定位难度，会创建 fallback `update_score`；这种情况下原 recent-event job 会取消自己的清理标记，由 fallback `update_score` 完成后再删好友，避免提前删除导致 fallback 抓分失败。

## Worker 死亡与重新 pick

worker pick 后，BullMQ job 进入该 bot queue 的 `active` 并持有 Redis lock。worker 进程活着时 BullMQ 会自动续锁；进程死掉后不再续锁。

lock 过期后，BullMQ 的 stalled 检查会把 job 从 `active` 重新放回同一个 bot queue。之后该 bot worker 重启或 cookie 恢复后，会重新 pick 到这个 job。

如果同一个 BullMQ job 超过 BullMQ 允许的 stalled 次数而最终失败，backend `QueueEvents` 会把 MongoDB job 标记为 `failed`。

## 状态与 ACK 的关系

BullMQ job 完成不代表业务 job 完成。当前流程中：

- **业务是否完成**看 MongoDB `jobs.status`。
- **投递 / 是否 active**看 BullMQ queue state。
- **等待到未来时间**同时体现在 MongoDB `runAt` 和 BullMQ delayed state。

常见状态：

| 场景                 | MongoDB job            | BullMQ job                            |
| -------------------- | ---------------------- | ------------------------------------- |
| 等待执行             | `queued/processing`    | `waiting`                             |
| 正在执行             | `processing`           | `active`                              |
| 等用户接受好友       | `processing` + `runAt` | `delayed`                             |
| 已完成 / 失败 / 取消 | 终态                   | BullMQ job 完成并移除，或已 failed    |
| worker 死亡待恢复    | 非终态                 | `active` 到 lock 过期后变回 `waiting` |

## 当前实现注意点

- 这是 **at-least-once**，不是 exactly-once；worker 死在外部副作用之后、状态 PATCH 之前时，可能重跑同一业务 stage。
- named queue 消除了“错误 bot 抢到 job 后 delay 5 秒”的软路由，但要求创建时必须正确绑定 `botUserFriendCode`。
- 如果某个 bot 长时间不可用，它的 named queue 会积压；`BotStatusService.cleanupStaleJobs()` 会把分配给不可用 bot 的活跃业务 job 标记失败。
- `jobs` 集合有 7 天 TTL；业务排查看 MongoDB job / worker logs，投递排查看对应 bot 的 BullMQ queue state。
