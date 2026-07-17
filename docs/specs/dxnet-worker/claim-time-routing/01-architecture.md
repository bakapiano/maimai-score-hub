# 目标架构与执行流程

## 1. 当前职责问题

当前 cabinet-assisted `update_score` 的关键顺序是：

```text
HTTP / scheduler
  -> backend pickAvailableCabinetBot()
  -> backend await sdgb.addRival(bot, target)
  -> backend 创建 Mongo job，写死 botUserFriendCode
  -> backend enqueue dxnet-worker-jobs-<bot>
  -> 对应 worker 最终执行 DXNet handler
```

这实际上把“调度决定”和“外部副作用”放在 worker 真正取得执行能力之前。backend 选中的
Bot 只代表 pick 时刻可用，并不代表稍后仍有 cookie、好友容量或 worker slot。

目标顺序改成：

```text
HTTP / scheduler
  -> backend 创建未分配 Mongo job
  -> enqueue shared lane queue
  -> 任一具备能力的 DXNet worker claim
  -> backend 原子绑定 claimant Bot
  -> claimant worker 请求 prepare cabinet friendship
  -> backend enqueue/await sdgb add_rival
  -> claimant worker 执行 DXNet handler
  -> completed 后按策略 cleanup friend
```

`addRival` 因此更接近真正使用好友关系的时间，Bot 的选择也由实际可执行 worker 决定。

## 2. 混合路由，而不是全部改成公共队列

job 增加显式 `assignmentMode`：

| assignmentMode | 创建时 `botUserFriendCode` | 投递位置 | 使用场景 |
| --- | --- | --- | --- |
| `claim` | `null` | shared lane queue | cabinet-assisted update、自动 recent event、可由任一 Bot 执行的工作 |
| `pinned` | 必填 | 对应 Bot queue | 已知好友关系、用户必须看到指定 Bot、刷新指定 Bot 自己的好友列表 |

推荐保留 pinned 的场景：

- `accept_friend_request`：用户需要先知道向哪个 Bot 发请求。
- 已有好友 snapshot 命中的 `update_score`：只有命中的 Bot 能立即读 Friend VS。
- `friendshipJobId` 指向刚完成的好友申请：继续使用证明中的 Bot。
- 刷新某个已知 Bot 的完整好友列表。

推荐使用 claim 的场景：

- 用户已绑定 `cabinetUserId`，但当前没有可靠好友 snapshot 的手动 `update_score`。
- 后续恢复的自动更新 `get_user_recent_event`。
- QR login slow path 中“选择任一可用 cabinet Bot、addRival、刷新该 Bot snapshot”的组合任务。
- 普通 `send_friend_request` 若产品流程不要求创建响应立即返回 Bot；若需要立即展示 Bot，仍走
  pinned。

## 3. 创建阶段

backend 创建 job 时不再同步等待 `addRival`。创建请求只完成以下工作：

1. 判定 job source、lane、priority 和 assignment mode。
2. 校验目标用户是否具备执行前提，例如 cabinet-assisted job 要求用户已绑定
   `cabinetUserId`。
3. 如果已有可靠 friend snapshot 或 friendship proof，直接生成 pinned job，且不需要
   cabinet prerequisite。
4. 否则生成 claim job：`botUserFriendCode=null`，`cabinetFriendship.status=pending`。
5. 写 Mongo 后立即 enqueue 对应 shared lane queue，并向调用方返回 queued job。

手动 API 不再因为 sdgb 慢而阻塞。若后续 `addRival` 失败，job 进入结构化失败或重试状态，
前端通过现有 job polling 展示结果。

## 4. Worker claim 协议

worker 从 shared lane queue 获得 `{ jobId }` 后，先调用新的原子接口：

```http
POST /api/v1/workers/dxnet/jobs/:jobId/claim
X-API-Secret: ...

{
  "workerId": "dxnet-worker-aliyun-bot12",
  "botFriendCode": "413252453611467",
  "deliveryId": "<bullmq job id>:<attempt>"
}
```

backend 必须检查：

- job 尚未终结。
- job lane 与 worker 当前消费 lane 一致。
- claimant Bot 最近有 heartbeat、`available=true`。
- 需要 cabinet friendship 时，该 Bot 已配置 `cabinetUserId` 且未超过好友容量门槛。
- `assignmentMode=claim` 时，当前没有有效 claim，或旧 claim lease 已过期。
- `assignmentMode=pinned` 时，claimant Bot 必须等于 `botUserFriendCode`。

成功时 backend 用一个原子 `findOneAndUpdate` 写入：

```ts
{
  botUserFriendCode,
  claimedByWorkerId,
  claimToken,
  claimAttempt,
  claimLeaseExpiresAt,
  status: "processing",
  updatedAt
}
```

响应只返回执行所需的非敏感信息和 opaque `claimToken`。worker 后续 PATCH、prepare、delay
都必须带 token，避免旧 delivery 在 lease 被接管后继续写状态。

## 5. Worker-triggered cabinet prerequisite

claim 成功后，如果 job 的 `cabinetFriendship.status !== ready`，worker 调：

```http
POST /api/v1/workers/dxnet/jobs/:jobId/prepare-cabinet-friendship
X-API-Secret: ...

{
  "claimToken": "opaque-token"
}
```

backend 在该接口中：

1. 校验 claim token 和 lease。
2. 从 job 的目标用户读取 `targetCabinetUserId`。
3. 从已经绑定的 `botUserFriendCode` 读取 `botCabinetUserId`。
4. 生成幂等 key：`dxnet:<jobId>:claim:<claimAttempt>:add-rival`。
5. 按 parent job 的 traffic class enqueue sdgb `add_rival`。
6. 等待 sdgb 结果，并原子写入 `cabinetFriendship=ready`。
7. 返回 `{ ready: true }`，worker 才开始 DXNet handler。

这里的“worker-side addRival”指 worker 决定调用时机并等待 prerequisite；cabinet 协议、ID
解析、鉴权和 sdgb BullMQ enqueue 仍留在 backend/sdgb-worker。

## 6. 各业务路径

### 6.1 手动 update_score

```text
POST /me/dxnet-jobs
  -> 有现成好友 snapshot/proof：pinned user-sync job
  -> 只有 cabinet binding：claim user-sync job + pending prerequisite
  -> worker claim -> addRival -> update_score
```

`addRival` 失败时：

- 可重试基础设施错误：job delay/backoff，释放 active slot。
- 明确业务拒绝或超时超过用户 deadline：job failed，返回稳定错误码
  `cabinet_friendship_failed`；前端可引导传统好友申请流程。

### 6.2 自动更新 get_user_recent_event

自动 scheduler 只创建 background claim job，不选 Bot、不调用 `addRival`。background worker
取得 slot 后才执行：

```text
claim bot -> addRival -> optional settle delay -> get_user_recent_event -> cleanup
```

这样后台 backlog 不会提前制造大量好友关系。单用户 cooldown、coalesce 和 backoff 仍在
scheduler 层保留。

### 6.3 QR login slow path

不要继续由 backend 先 pick Bot 再 addRival。建议引入一个显式 purpose，例如：

```ts
jobType: "get_full_friend_list"
context: {
  purpose: "qr_login_resolution",
  qrAttemptId
}
assignmentMode: "claim"
cabinetFriendship: "pending"
lane: "interactive"
```

worker claim 后 addRival，再抓取自己 Bot 的 friend list。backend 根据最终绑定的
`botUserFriendCode` 和 fresh snapshot 完成 name/rating 反查。若后续实现复杂度允许，可再把
它提升为独立 `resolve_qr_login` job type，避免长期复用 `get_full_friend_list` 的语义。

### 6.4 好友申请类 job

`accept_friend_request` 必须在用户操作前给出 Bot，继续 pinned。
`send_friend_request` 可以按产品交互选择：

- 创建响应必须立即返回 Bot：backend 预选但不做 addRival，走 pinned interactive queue。
- 可以先返回 queued、稍后显示 Bot：走 shared interactive claim。

## 7. 为什么不让 DXNet worker直接调用 sdgb-worker

- DXNet worker 不应持有目标用户 cabinet id、Bot cabinet id 或 sdgb 协议配置。
- backend 已经是 job 权限、用户绑定、审计和 sdgb dispatcher 的 owner。
- 直接 worker-to-sdgb 会新增一套鉴权、重试、幂等和观测协议。
- prepare endpoint 可以在不暴露敏感字段的前提下达到“执行时才 addRival”的目标。

