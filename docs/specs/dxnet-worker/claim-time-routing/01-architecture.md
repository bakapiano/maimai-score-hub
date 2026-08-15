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
  -> BullMQ 原子选择一个 DXNet worker 进入 active
  -> worker 通过现有 PATCH 原子登记本次执行 Bot 和 delivery generation
  -> active worker 请求 prepare cabinet friendship
  -> backend enqueue/await sdgb add_rival
  -> active worker 执行 DXNet handler
  -> completed 后按策略 cleanup friend
```

`addRival` 因此更接近真正使用好友关系的时间，Bot 的选择也由实际可执行 worker 决定。
BullMQ lock 是唯一执行权；Mongo 不再复制一套 claim lease。backend 保存的 execution 字段
只用于业务审计和拒绝 stalled/redelivery 后的旧 worker 写入。

## 2. 混合路由，而不是全部改成公共队列

job 增加显式 `assignmentMode`：

| assignmentMode | 创建时 `botUserFriendCode` | 投递位置 | 使用场景 |
| --- | --- | --- | --- |
| `claim` | `null` | shared lane queue | cabinet-assisted update、自动 recent event、可由任一 Bot 执行的工作 |
| `pinned` | 必填 | 对应 Bot queue | 已知好友关系、用户必须看到指定 Bot、刷新指定 Bot 自己的好友列表 |

这里的 `claim` 表示由 BullMQ shared queue 竞争取得 active delivery，不表示 backend 还要执行
第二轮抢占。

另有运行时 `deliveryMode: "shared" | "pinned"`。原生 pinned job 始终是 pinned；claim job
初始为 shared，但 addRival 后若需要长 settle，可暂时 handoff 到当前 Bot 的 pinned lane，仍保留
`assignmentMode=claim` 的可重分配语义。

固定使用 pinned 的场景：

- `accept_friend_request`：用户需要先知道向哪个 Bot 发请求。
- 5 分钟内更新的完整好友 snapshot 命中的 `update_score`：只有命中的 Bot 能立即读 Friend VS。
- `friendshipJobId` 指向刚完成的好友申请：继续使用证明中的 Bot。
- 刷新某个已知 Bot 的完整好友列表。

固定使用 claim 的场景：

- 用户已绑定 `cabinetUserId`，但当前没有 5 分钟内完整好友 snapshot 的手动 `update_score`。
- 后续恢复的自动更新 `get_user_recent_event`。
- QR login slow path 中“选择任一可用 cabinet Bot、addRival、刷新该 Bot snapshot”的组合任务。

## 3. 创建阶段

backend 创建 job 时不再同步等待 `addRival`。创建请求只完成以下工作：

1. 判定 job source、lane、priority、assignment mode 和 deadline。
2. 校验目标用户是否具备执行前提，例如 cabinet-assisted job 要求用户已绑定
   `cabinetUserId`。
3. 如果已有 `friendsUpdatedAt >= now - 5min` 的完整 friend snapshot，或 10 分钟内的
   friendship proof，直接生成 `assignmentMode=pinned, deliveryMode=pinned` job，且不需要
   cabinet prerequisite。
4. 否则生成 claim job：`botUserFriendCode=null`、`cabinetFriendship.status=pending`、
   `deliveryMode=shared`。所有通过 addRival 创建的关系都是临时关系，并统一由现有周期
   CleanupService 在确认没有 active job 后移除。QR identity internal job 的 public
   `friendCode` 保持 null，真实 target 由 identity attempt 的 rival-name 保护结束后交给周期清理。
5. 写 Mongo 后立即 enqueue 对应 shared lane queue。BullMQ payload 包含
   `{ jobId, deliveryEpoch }`；BullMQ delivery id 固定为 `<mongoJobId>-e<deliveryEpoch>`。
   `deliveryEpoch` 由 backend 在每次新建、handoff 或 repair BullMQ job 时递增。
6. 向调用方返回 queued job。

手动 API 不再因为 sdgb 慢而阻塞。若后续 `addRival` 失败，job 进入结构化失败或重试状态，
前端通过现有 job polling 展示结果。

## 4. BullMQ activation 与现有 PATCH 登记

所有合格 worker 直接消费 shared lane queue。BullMQ 通过 waiting -> active 的原子转换和 active
lock 选出唯一的正常执行者；backend 不再提供 `/claim`、`/start-execution`、`/renew` 或
`/release` 接口。

部署拓扑仍是一 Bot、一 Node 进程、一套 CookieJar/MaimaiClient。每个进程内部为三条 lane
各创建 shared 与 pinned BullMQ consumer；这些只是同进程内的六个 `Worker` 对象，不新增
Bot 进程或共享同一 Cookie 的多进程。

worker processor 收到 BullMQ job 后，可读取：

```ts
{
  data: { jobId, deliveryEpoch },
  attemptsStarted
}
```

`attemptsStarted` 每次 BullMQ job 进入 active 都递增。`deliveryEpoch` 解决 queue repair 删除并
重建同一 job 后 `attemptsStarted` 从头计数的问题。两者组成有序 execution generation：

```text
(deliveryEpoch, attemptsStarted)
```

worker 应先检查 `runAt`；尚未到时间的 delivery 在登记 execution 前直接
`moveToDelayed`。可执行 job 直接复用现有 worker PATCH 登记 execution；不再进入本地 waiter 或
申请第二层 permit。shared/pinned 六个 consumer 各自使用 queue-level concurrency：interactive=8、
user_sync=16、background=16。

```http
PATCH /api/v1/workers/dxnet/jobs/:jobId
X-API-Secret: ...

{
  "status": "processing",
  "botUserFriendCode": "413252453611467",
  "execution": {
    "deliveryEpoch": 1,
    "attemptsStarted": 1,
    "queueName": "dxnet-shared-user-sync-jobs",
    "workerId": "dxnet-worker-aliyun-bot12"
  }
}
```

backend 必须在同一个原子 `findOneAndUpdate` 中检查并写入：

- job 尚未终结，routing version 和 queue/lane 一致。
- `workerId` 与 `botFriendCode` 必须匹配该 Bot 最新 heartbeat；heartbeat 包含 revision 和六个
  consumer ready 状态，且最近 90 秒内 `available=true`。
- 任何可能新建好友关系的 job 都要求 Bot 属于健康 worker set（可受 botAllowlist 限制）、持有
  5 分钟内的完整好友 snapshot 且 `friendCount < 50`；cabinet
  friendship 还必须配置 `cabinetUserId`。该 cutoff 同时适用于 claim addRival 和 pinned
  send/accept friend request；已确认存在的 pinned 好友关系不重复占容量。
- `assignmentMode=pinned` 时，请求 Bot 必须等于已经保存的 `botUserFriendCode`。
- 没有 execution 时接受首次登记。
- generation 相同且 worker/Bot 相同视为幂等重试。
- heartbeat、allowlist、snapshot 和 capacity 只在首次登记或更高 generation 接管时检查；已经
  登记的同 generation 后续 PATCH 只校验 route 与 execution fence，避免运行中 heartbeat 或
  容量变化阻断终态写入。
- incoming `deliveryEpoch` 必须等于当前 `routing.deliveryEpoch`。
- generation 严格更新时允许接管；`claim` job 可改绑到本次 BullMQ winner，`pinned` job
  只能由原 Bot 接管。
- generation 更旧、同 generation 但 worker/Bot 不同，返回稳定错误
  `409 stale_execution`。

容量不增加长期 reservation collection/counter。backend 复用现有 Redis 锁实现一个短生命周期
per-Bot assignment mutex；pinned relationship job 创建和 claim 首次 PATCH 都必须在锁内重新读取
fresh `friendCount`，并统计已经绑定该 Bot 的非终态 relationship-owning jobs：

```text
prospectiveFriendLoad = friendCount
  + other nonterminal relationship-owning jobs
  + 1 for the assignment being admitted
```

该值是有意的保守双计数；查询排除当前 job，再显式加入本次 reservation，
`prospectiveFriendLoad >= DXNET_BOT_FRIEND_LIMIT 80` 时拒绝本次分配。
Mongo job 自身就是隐式 reservation，terminal/claim 清 assignment 后自动退出计数，不维护第二
套 durable counter。worker 侧仍以 fresh `friendCount < 50` 作为 shared-consumer 快速门槛；
queue-level concurrency 不承担好友容量证明。per-Bot mutex 串行计算 effective load，并负责封住
backend 双副本、shared/pinned 同时建友和 delayed job 的并发竞态；达到 80 后即使 queue 仍有
execution slot 也拒绝新 assignment。mutex TTL 为 15 秒并每 5 秒续租、等待上限 2 秒；持锁
进程崩溃或丢失 lease 后自动释放/中止，已经落库的 Mongo job 继续作为 reservation。2 秒内未取得锁的请求不绕过检查：worker
assignment 走 5-10s jitter，用户创建请求返回
`503 { code: "bot_assignment_busy" }` 和 `Retry-After: 5`。

snapshot 过期时，已 active 的 shared job 先按自己的 `job.priority` 触发一次进程内去重的
on-demand full-friend refresh；刷新期间暂停该 Bot 其他 shared consumers。刷新成功且
friendCount < 50 时继续首次 PATCH；达到 50 时按同一 job.priority 触发一次去重的现有
CleanupService，再 refresh 复核。刷新/清理失败或复核后仍达到 50 时，当前 delivery 使用
`5s + [0,5s] jitter` 重新等待，让所有 Bot 重新竞争；本次检查结束后恢复 shared consumers，
当前实现不提供 worker-level cooldown。
backend 首次 PATCH 重复检查 snapshot age 和 count，作为防御性校验。
DXNet friend verification、send/accept 和 remove 已通过现有 MaimaiClient callbacks 更新本地
snapshot，并在 1 秒 debounce 后上报 backend；因此关系建立/删除后不必等待下一次 5 分钟全量
refresh 才更新 friendCount。

后续进度、delay 和 terminal PATCH 继续使用同一个接口，并携带相同 execution generation。
Mongo 更新条件必须包含该 generation；不能再只按 `{ id: jobId }` last-write-wins。

v2 worker PATCH 使用稳定响应：

```text
200                         accepted / same-generation idempotent retry
409 stale_execution         当前 processor 立即停止，旧 delivery 结束
409 bot_ineligible          当前 job 进入 5-10s jitter；snapshot/capacity 会先 cleanup/refresh
409 invalid_route           永久配置错误，当前 delivery failed 并报警
410 job_terminal            不再执行，正常结束当前 delivery
503 bot_assignment_busy     per-Bot mutex 繁忙，5-10s jitter
```

`bot_ineligible.reason` 固定为 `heartbeat|allowlist|cabinet_binding|snapshot_stale|capacity`，
worker 不解析 message 文本。

BullMQ 自己负责 active lock 续约以及 queue 状态变更的所有权校验；相关内部凭证不进入 Mongo
或 worker-backend 业务协议。worker 监听 `lockRenewalFailed`，把 AbortSignal 贯穿 prepare、
DXNet request 和 PATCH；失去 lock 后停止产生新操作。若 job 被 stalled checker 重新投递，
新 processor 的 `attemptsStarted` 更大，旧 generation 的 PATCH 会被 backend 拒绝。job
hard-timeout 从首次 execution PATCH 成功、准备执行 handler 时开始计算。

## 5. Worker-triggered cabinet prerequisite

首次 execution PATCH 成功后，`cabinetFriendship.status=pending/running` 时 worker 调用或恢复等待
prepare endpoint；`ready/uncertain` 直接进入对应 DXNet 验证路径，绝不能因 uncertain 再次
enqueue addRival：

```http
POST /api/v1/workers/dxnet/jobs/:jobId/prepare-cabinet-friendship
X-API-Secret: ...

{
  "execution": {
    "deliveryEpoch": 1,
    "attemptsStarted": 1,
    "workerId": "dxnet-worker-aliyun-bot12"
  }
}
```

backend 在该接口中：

1. 校验 execution generation、worker 和当前绑定 Bot；旧 generation 返回
   `409 stale_execution`。
2. 从 job 的目标用户读取 `targetCabinetUserId`。
3. 从已经绑定的 `botUserFriendCode` 读取 `botCabinetUserId`。
4. 生成幂等 key：
   `dxnet:<jobId>:delivery:<deliveryEpoch>:bot:<botFriendCode>:add-rival`。
5. 按 parent `job.priority` enqueue sdgb `add_rival`。
6. 等待 sdgb 结果。`returnCode1/2` 是 opaque diagnostic value；线上存在多种正常组合，不能
   根据某个数值组合推导“成功/已存在/拒绝”。sdgb job completed 且两个字段都是非负整数时，
   表示已收到确定响应，写入 `cabinetFriendship.status=ready`，允许尝试 DXNet；当前 adapter
   用 `-1` 表示缺字段，必须按 invalid_response 写 uncertain，不能当 ready 或立即重发。
7. sdgb job `outcomeUnknown=true` 时写入 `status=uncertain`，禁止立即再次发送 mutation；worker
   进入与 ready 相同的 DXNet 验证路径。明确在 mutation 前失败才可按 lane retry policy 重试
   同一幂等 sdgb job。
8. 所有 parent job 更新都必须匹配当前 execution generation；generation 已变化时不得更新
   parent job，已经发生的 friendship 副作用交给该 Bot 已有的周期 CleanupService。
9. worker 按 source 执行 settle/验证：
   - manual update_score：立即通过 DXNet friend search 验证，失败后在 2s、5s 各重试一次。
   - auto recent-event：addRival 后 handoff 到同 Bot 的 pinned background queue，延迟 3 分钟；
     settle 不占 BullMQ active slot，continuation 再验证并执行 handler。
   - QR resolution：沿用 fresh full-friend snapshot，最长等待 90 秒，并按 name/rating 唯一反查。

`ready` 在这里表示“addRival 得到确定响应、可以尝试 DXNet”，不是对返回码语义的解释；
`uncertain` 表示 mutation 可能已发生，只能通过 DXNet 侧事实确认。

这里的“worker-side addRival”指 worker 决定调用时机并等待 prerequisite；cabinet 协议、ID
解析、鉴权和 sdgb BullMQ enqueue 仍留在 backend/sdgb-worker。

## 6. 各业务路径

### 6.1 手动 update_score

```text
POST /me/dxnet-jobs
  -> 有现成好友 snapshot/proof：pinned user-sync job
  -> 只有 cabinet binding：claim user-sync job + pending prerequisite
  -> BullMQ active -> 首次 PATCH 绑定 Bot -> addRival -> update_score
```

`addRival` 失败时：

- mutation 前的 backend/enqueue 基础设施错误：5s 起步退避，受 20 分钟 user_sync deadline
  限制。
- definite sdgb failure 返回 `cabinet_friendship_failed`；outcome unknown 后 DXNet 验证仍未形成
  好友返回 `cabinet_friendship_unconfirmed`；没有合格 Bot 直到 deadline 返回
  `cabinet_bot_unavailable`。三者都允许 frontend 引导传统 pinned 好友申请流程。

### 6.2 自动更新 get_user_recent_event

自动 scheduler 只创建 background claim job，不选 Bot、不调用 `addRival`。background worker
取得 slot 后才执行：

```text
shared active -> PATCH 绑定 Bot -> addRival
  -> handoff 到当前 Bot pinned background queue，delay 3min
  -> pinned active -> verify -> get_user_recent_event -> cleanup
```

handoff PATCH 在同一个 Mongo CAS 中保留 `botUserFriendCode`、设置 `deliveryMode=pinned`、递增
`deliveryEpoch`、写入 `status=queued, runAt=now+3min`，随后 enqueue 新 epoch 到该 Bot 的 pinned background
queue；当前 shared delivery 才结束。这样 settle 不占 recent-event execution slot，也不会被另一
Bot 抢走后重复 addRival。若该 Bot 在 continuation 前失效，backend 将 claim job 的
`deliveryMode` 改回 shared、清 Bot、再次递增 epoch；现有 CleanupService 处理旧关系。

recent-event 触发 fallback `update_score` 时沿用当前所有权转移：child 创建为同 Bot 的 pinned
background job；parent 和 child 都退出 active 列表后，再由周期 cleanup 清理关系。

这样后台 backlog 不会提前制造大量好友关系。单用户 cooldown、coalesce 和 backoff 仍在
scheduler 层保留。

### 6.3 QR identity slow paths

QR login slow path，以及 cabinet binding 在本地成绩少于 4 条时的 profile fallback，当前都
调用同一个 `CabinetIdentityMatcher` 提前 pick Bot/addRival。两者一起迁移，固定复用现有
get_full_friend_list job type，并增加显式 purpose：

```ts
jobType: "get_full_friend_list"
context: {
  purpose: "qr_login_resolution" | "cabinet_binding_resolution",
  identityAttemptId
}
friendCode: null
assignmentMode: "claim"
cabinetFriendship: "pending"
lane: "interactive"
cancelActiveJobs: false
```

worker 被 BullMQ 激活并通过首次 PATCH 绑定 Bot 后执行 addRival，再抓取自己 Bot 的 friend
list。backend 根据最终绑定的
`botUserFriendCode` 和 fresh snapshot 完成 name/rating 反查。本文不新增
`resolve_qr_login` job type。

`friendCode=null` 只允许出现在这两个 internal purpose；首次 execution PATCH 必须把 `friendCode` 和
`botUserFriendCode` 同时设为 BullMQ winner 的 Bot friend code，之后再执行现有
get_full_friend_list handler。backend 扩展现有 1-day TTL identity attempt，增加
`purpose=login|cabinet_binding`、owner/expectedFriendCode 和对应结果字段；不再新增另一套
worker job type或解析器。QR service 先创建 `botUserFriendCode=null` 的 attempt，并把当前
`CabinetIdentityMatcher.prepare()` 拆成“计算 name/rating”和“execution-time 解析 Bot”两步，
不再在创建 attempt 时 pick Bot。该 internal job 不通过普通 `/me/dxnet-jobs` public response
暴露 nullable friendCode，也不能参与按 friendCode 取消旧 job 的通用逻辑；QR attempt 去重只按
`identityAttemptId`。

login 沿用现有 public attempt polling 并在 matched 后签发 token；authenticated cabinet binding
在 profile fallback 时返回 `202 { attemptId }`，frontend 轮询绑定 attempt，唯一反查结果必须等于
当前用户 friendCode 才写入 cabinetUserId。本地成绩至少 4 条的 score-match binding 不需要
addRival，继续走当前同步路径。

现有 CleanupService 的 QR rival-name 保护查询扩展为所有 pending/running identity attempts，
包括 cabinet binding；否则 target friendCode 尚未反查出来时可能被周期清理提前删除。

### 6.4 好友申请类 job

`accept_friend_request` 必须在用户操作前给出 Bot，继续 pinned。
`send_friend_request` 的创建响应也必须立即返回用户应操作的 Bot，因此第一版固定走 pinned
interactive queue；backend 只预选 Bot，不做 addRival。本文不引入“先 queued、稍后展示 Bot”
的第二套产品流程。

## 7. 为什么不让 DXNet worker直接调用 sdgb-worker

- DXNet worker 不应持有目标用户 cabinet id、Bot cabinet id 或 sdgb 协议配置。
- backend 已经是 job 权限、用户绑定、审计和 sdgb dispatcher 的 owner。
- 直接 worker-to-sdgb 会新增一套鉴权、重试、幂等和观测协议。
- prepare endpoint 可以在不暴露敏感字段的前提下达到“执行时才 addRival”的目标。
