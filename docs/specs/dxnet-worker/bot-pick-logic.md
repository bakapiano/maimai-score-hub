# DXNet Bot Pick 逻辑

本文档根据当前代码实现整理 DXNet job 创建时如何选择 `botUserFriendCode`。DXNet worker 已改为 per-bot named queue，因此 **job 创建前必须先决定 bot**，随后进入 `dxnet-worker-jobs-<botFriendCode>`。

## 关键结论

- **没有公共队列抢占分配**：普通 DXNet job 不再靠 worker 抢到后写入 bot；后端创建 job 时必须写入 `botUserFriendCode`。
- **通用 pick 区分容量和负载**：`friendCount` 只作为好友容量约束和同负载 tie-breaker；实际负载看 `queued/processing` in-flight job 数。
- **Cabinet 场景要求 bot 绑定 cabinet userId**：`pickAvailableCabinetBot()` 额外要求 `cabinetUserId != null`，同样会过滤好友数已满的 bot。
- **用户侧 friendship 会暴露机台绑定布尔值**：`/me/dxnet-jobs/friendship` 返回 `hasCabinetUserId`，但不返回具体机台 ID；前端可据此直接创建 `update_score` 走 cabinet fast-path。
- **`update_score` 优先选择已有好友关系的 bot**：如果某个可用 bot 的好友快照里已有目标用户，就直接绑定该 bot；否则才走 cabinet fast-path 或要求前置好友关系 job。
- **pick 结果不会在 worker 侧重分配**：worker 只消费自己的 named queue；投递到错误 queue 会 fail，而不是换 bot。

## 相关代码入口

| 文件                                                                        | 作用                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `backend/src/modules/bots/services/bot-status.service.ts`                   | bot 可用性归一化、`pickAvailableBot()`、`pickAvailableCabinetBot()`            |
| `backend/src/modules/bots/services/bot-friend-snapshot.service.ts`          | 从 bot 好友快照查找目标用户在哪个 bot 好友列表里                               |
| `backend/src/modules/job/services/job.service.ts`                           | `JobService.create()` 解析 jobType、好友关系、cabinet fast-path、最终 bot 兜底 |
| `backend/src/modules/auth/services/auth.service.ts`                         | friendCode 登录创建 `send_friend_request` / `accept_friend_request`            |
| `backend/src/modules/auth/services/qr-login.service.ts`                     | QR login slow path 使用 cabinet bot 并刷新同一 bot 好友快照                    |
| `backend/src/modules/auto-update/services/auto-update-scheduler.service.ts` | FC/FS enrichment 选择 cabinet bot                                              |

## Bot 可用性

Bot 状态来自 worker 上报的 `bot_statuses`：

1. Worker 上报 `available`、`friendCount`、`friendsUpdatedAt`、好友快照。
2. `BotStatusService.getAll()` 返回前会做 5 分钟超时降级：`lastReportedAt` 超过 5 分钟时，即使 DB 里是 `available=true`，返回也会变成 `available=false`。
3. 所有 pick 逻辑都只使用 `getAll()` 返回后的可用性。

## 通用容量过滤和负载排序

`pickAvailableBot()` 和 `pickAvailableCabinetBot()` 共用同一套候选过滤和排序。

### 1. 好友容量过滤

```text
friendCount == null || friendCount < DXNET_BOT_FRIEND_LIMIT
```

`DXNET_BOT_FRIEND_LIMIT` 默认是 `90`，低于 DXNet 100 好友硬上限，给 worker 自己的异步清理留出余量。好友数不是 worker 处理负载，只是 DXNet 好友容量约束；达到或超过上限的 bot 不再参与 pick。`friendCount=null` 表示还没有可靠快照，当前不会直接排除，但在同负载排序时会排在已知好友数较低的 bot 后面。

### 2. in-flight job 负载排序

容量过滤后，按当前活跃 job 数排序：

```text
jobLoad = count(jobs where botUserFriendCode = bot && status in ["queued", "processing"])
```

`jobLoad` 才表示 worker 的实际处理压力。排序规则：

1. `jobLoad` 小的优先。
2. `jobLoad` 相同时，`friendCount` 小的优先，给剩余好友容量更大的 bot。
3. `friendCount=null` 在 tie-breaker 中按上限值处理，避免未知容量的 bot 被优先选择。

## `pickAvailableBot()`

用于不要求 cabinet 能力的 DXNet job。

候选条件：

```text
available === true
&& (friendCount == null || friendCount < DXNET_BOT_FRIEND_LIMIT)
```

返回：

```json
{
  "friendCode": "336560109012350"
}
```

当前使用点：

| 场景                    | 行为                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `send_friend_request`   | `JobService.create()` 如果调用方未传 bot，兜底调用 `pickAvailableBot()`                                      |
| `accept_friend_request` | `AuthService.requestLogin(method="user_sends_request")` 先调用 `pickAvailableBot()`，再创建绑定该 bot 的 job |

如果没有候选 bot，创建接口会返回“当前没有可用的 Bot”。

## `pickAvailableCabinetBot()`

用于需要先走 sdgb / cabinet 能力的场景。

候选条件：

```text
available === true
&& cabinetUserId != null
&& (friendCount == null || friendCount < DXNET_BOT_FRIEND_LIMIT)
```

返回：

```json
{
  "friendCode": "336560109012350",
  "cabinetUserId": 12345678
}
```

当前使用点：

| 场景                             | 行为                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `update_score` cabinet fast-path | 用户有 `cabinetUserId` 且调用方未指定 bot 时，先 pick cabinet bot，再用 sdgb `addRival` 建立 cabinet 侧好友关系 |
| QR login slow path               | 先 pick cabinet bot，执行 sdgb `addRival`，再创建绑定同一 bot 的 `get_full_friend_list` job 刷新好友快照        |
| 自动更新 FC/FS enrichment        | 先 pick cabinet bot，执行 sdgb `addRival`，再创建绑定同一 bot 的 `get_user_recent_event` job                    |

如果没有候选 bot，相关流程会失败并提示当前没有可用、配置了 cabinet userId 的 bot。

## `update_score` 的 bot 解析顺序

`update_score` 的目标是让已经能访问目标用户成绩的 bot 执行，因此它不是简单调用 `pickAvailableBot()`。

创建时顺序如下：

1. **调用方显式传入 `botUserFriendCode` 且 `friendshipReady=true`**：直接使用该 bot。
2. **用户绑定了 `cabinetUserId` 且 `friendshipReady=false`**：
   - 如果调用方已传 bot，则检查这个 bot 是否有 `cabinetUserId`。
   - 如果未传 bot，则调用 `pickAvailableCabinetBot()`。
   - 找到 cabinet bot 后调用 sdgb `addRival(botCabinetUserId, targetCabinetUserId)`。
   - addRival 成功则认为好友关系 ready，并绑定这个 bot。
   - addRival 失败则继续走普通好友关系校验。
3. **已有好友快照命中**：
   - 读取所有 `available=true` bot，按 `friendCount` 从小到大排序。
   - 用这个顺序在 `bot_statuses.friends` 中查找目标 `friendCode`。
   - 命中哪个 bot，就绑定哪个 bot。
4. **调用方提供 `friendshipJobId`**：
   - 校验这个 job 属于同一目标用户、`jobType=send_friend_request`、`status=completed`、有 `botUserFriendCode`、且完成时间未超过 10 分钟。
   - 校验通过后继承该 `send_friend_request` job 的 bot。
5. **仍无法证明好友关系**：
   - 返回 `needs_friendship`。
   - `recommendedBotFriendCode` 是当前可用 bot 中 `friendCount` 最小的 bot，仅用于提示前端先创建好友关系 job。

注意：第 3 步使用的是 `friendCount` 排序，不叠加 in-flight job；这是为了优先复用“已经是好友”的 bot，而不是重新负载均衡到可能还不是好友的 bot。

## 其他 jobType 的绑定规则

| jobType                 | 当前规则                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `send_friend_request`   | 未传 bot 时调用 `pickAvailableBot()`；创建后进入该 bot named queue                                                |
| `accept_friend_request` | 登录入口先调用 `pickAvailableBot()` 并传入 bot；`JobService.create()` 也有同样兜底                                |
| `get_user_recent_event` | 必须由调用方传 bot；当前主要来自自动更新 FC/FS enrichment                                                         |
| `get_full_friend_list`  | 通常调用方传 bot；未传时 `JobService.create()` 用 `friendCode` 作为 bot code，适用于“刷新某个 bot 自己的好友列表” |

## 用户侧 friendship 与 cabinet fast-path

前端点击“更新数据”前会调用：

```http
GET /api/v1/me/dxnet-jobs/friendship
```

响应包含：

```json
{
  "isFriend": false,
  "hasCabinetUserId": true,
  "botFriendCode": null,
  "recommendedBotFriendCode": "336560109012350"
}
```

`hasCabinetUserId` 只表示当前用户是否已绑定机台，不暴露具体 `cabinetUserId`。

前端逻辑：

1. `isFriend=true`：直接创建 `update_score`。
2. `hasCabinetUserId=true`：直接创建 `update_score`。后端创建 job 时执行 `tryCabinetFastPath()`，选择 cabinet bot 并调用 sdgb `addRival`。
3. 两者都为 false：先创建 `send_friend_request`。

如果第 2 种情况下 addRival 失败，后端仍返回 `needs_friendship`，前端 fallback 创建 `send_friend_request`。

## 与 named queue 的关系

最终创建出的 MongoDB job 一定带 `botUserFriendCode`：

```ts
{
  id,
  jobType,
  status: "queued",
  botUserFriendCode: "<picked bot>"
}
```

然后后端 enqueue 到：

```ts
dxnet-worker-jobs-<picked bot>
```

worker 不会再改写 `botUserFriendCode`。如果某个 job 缺失 `botUserFriendCode`，或被投递到了不匹配的 bot queue，worker 会把这个业务 job 标记为 `failed`，因为这代表后端路由数据错误。

## 不可用 bot 的后续处理

如果 bot 后续过期或 5 分钟未上报：

1. `getAll()` 会把它视为 `available=false`，后续 pick 不再选它。
2. `BotStatusService.cleanupStaleJobs()` 每 5 分钟扫描一次，把已分配给不可用 bot 且仍处于 `queued/processing` 的 job 标记为 `failed`，错误为“Bot Cookie 已过期或不可用”。
3. 该 bot 的 named queue 可能仍有 BullMQ job，但业务 job 已是终态后，worker 再拿到会直接返回。

## 自动更新后的好友清理

自动更新 FC/FS enrichment 会先 `addRival`，再创建绑定同一 bot 的 `get_user_recent_event` DXNet job。为了避免这类临时好友持续占用 100 人好友容量，自动更新创建的 DXNet job 会设置：

```ts
removeFriendAfterComplete: true;
```

worker 只在 job 成功 `completed` 后 fire-and-forget 删除目标好友，不等待删除请求完成，也不影响 BullMQ job 完成。

特殊情况：`get_user_recent_event` 完成后如果触发 fallback `update_score`，后端会把原 recent-event job 的清理标记改回 `false`，并让 fallback `update_score` 带 `removeFriendAfterComplete=true`。这样好友关系会保留到 fallback 抓分完成后再删除。
