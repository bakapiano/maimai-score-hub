# 状态、失败恢复与幂等

## 1. Mongo 仍是业务 source of truth

BullMQ 只保存 delivery。`jobs` 新增：

```ts
type AssignmentMode = "claim" | "pinned";
type ExecutionLane = "interactive" | "user_sync" | "background";

interface DxnetJobRouting {
  version: 2;
  deliveryEpoch: number;
  source: DxnetJobSource;
  lane: ExecutionLane;
  assignmentMode: AssignmentMode;
  deliveryMode: "shared" | "pinned";
}

interface DxnetJobExecution {
  deliveryEpoch: number;
  attemptsStarted: number;
  workerId: string;
  startedAt: Date;
}

// Job 上的 execution 初始为 null；首次 worker PATCH 后写入上述结构。
type CurrentDxnetJobExecution = DxnetJobExecution | null;

interface CabinetFriendshipState {
  status:
    | "not_required"
    | "pending"
    | "running"
    | "ready"
    | "uncertain"
    | "failed";
  botFriendCode: string | null;
  deliveryEpoch: number | null;
  attemptsStarted: number | null;
  sdgbJobId: string | null;
  lastError: string | null;
}

type DxnetJobErrorCode =
  | "cabinet_bot_unavailable"
  | "cabinet_friendship_failed"
  | "cabinet_friendship_unconfirmed"
  | "job_deadline_exceeded";
```

`targetCabinetUserId` 不进入公共 job response；backend 由 job 的 user identity 在 prepare 时
解析。

job 另存 `deadlineAt: Date` 和 `errorCode: DxnetJobErrorCode | null`。public response 只新增
`cabinetFriendshipStatus` 与 `errorCode`；`execution`、sdgb job id、cabinet user id 和内部错误
细节都不公开。frontend 用 pending/running 显示“正在准备好友关系”，用 uncertain 显示“正在
确认好友关系”，上述 cabinet 错误提供传统 pinned 好友申请 fallback。

`friendCode` 仅对 `context.purpose=qr_login_resolution|cabinet_binding_resolution` 的 internal
v2 `get_full_friend_list` job 允许初始为 null，并在首次 execution PATCH 原子填成 claimant Bot
friend code；其他 job 创建、Mongo validation 和 public contract 仍要求非空 friendCode。
shared contract 拆分 `WorkerJobResponseSchema`（该 purpose 可 nullable）与
`PublicJobResponseSchema`（始终 string）；不能放宽现有 public schema 后依赖 frontend 自己判断。

新增索引固定为：

```text
{ "routing.version": 1, status: 1, deadlineAt: 1 }       # deadline sweep
{ "routing.version": 1, "routing.lane": 1, status: 1 } # repair/admin depth
{ botUserFriendCode: 1, status: 1 }                     # 复用现有 capacity/active 查询
```

`execution` 随 job 单文档 CAS，不需要单独索引。部署先后台创建索引并确认完成，再开启 v2
producer，不能让两个 backend replicas 在启动时同时阻塞建索引。

## 2. 状态转换

claim job 的主要状态：

```text
queued / unassigned
  -> BullMQ waiting -> active
  -> 首次 worker PATCH 原子登记 execution / processing
  -> prerequisite running
  -> prerequisite ready / uncertain
  -> source-specific settle and DXNet verification
  -> DXNet handler running
  -> completed
```

重试：

```text
prerequisite transient failure
  -> 同 generation PATCH queued + runAt/backoff
  -> assignmentMode=claim 时清 botUserFriendCode
  -> 保留上一 generation 作为 stale-write fence，不新增 execution state
  -> BullMQ moveToDelayed

worker death / BullMQ stalled
  -> BullMQ lock renewal stops
  -> stalled checker moves the same BullMQ job back to wait
  -> another worker starts with attemptsStarted+1

BullMQ job 丢失并由 repair 重建
  -> backend 原子递增 routing.deliveryEpoch
  -> enqueue { jobId, deliveryEpoch }
  -> attemptsStarted 在新的 BullMQ job 内从头计数

claim job 完成 addRival 后需要长 settle
  -> 同 generation CAS 设置 status=queued + deliveryMode=pinned + runAt
  -> routing.deliveryEpoch += 1
  -> enqueue 当前 Bot pinned lane 的新 epoch
  -> 结束旧 shared delivery并释放 execution slot
```

现有 public `status` 可以继续使用 `queued/processing/completed/failed/canceled`；execution 和
prerequisite 细节通过新增字段和 timeline event 表达，不必立即增加 public status enum。

`update_score/get_user_recent_event` 的终态副作用采用内部 `completionPending=true`：先持久化
result 和 completion intent，并把 deadline 至少延长 5 分钟，再执行成绩合并/活动记录，最后 CAS
为 completed 并清除标记。completion pending 期间 BullMQ failed mirror 和旧 Job cancellation 不得
抢先改写；若进程崩溃，worker 可用同一 execution 重试，grace 到期后 deadline sweep 才终结。

## 3. BullMQ lock 与 execution generation fencing

BullMQ active lock 是唯一执行权。Mongo 不实现第二套执行 lease，也没有 renew/sweeper。多个
worker 正常竞争同一 shared queue 时，由 BullMQ 原子选择唯一 active processor；这不承诺严格
round-robin 公平，也不承诺 exactly-once。

BullMQ 自己负责 lock 续约和 queue 状态变更的所有权校验，相关内部凭证不进入 Mongo 或
worker-backend 业务协议。backend 业务写入只使用以下 generation fencing：

```text
executionGeneration = (routing.deliveryEpoch, bullmqJob.attemptsStarted)
```

- `deliveryEpoch` 由 backend 创建 BullMQ job 时写进 payload；repair/跨 queue 重投前递增。
- `attemptsStarted` 由 BullMQ 每次 waiting -> active 时递增。
- worker 第一次和后续每次 PATCH 都携带 generation、workerId、queueName 和 Bot。
- 没有 execution 时接受首次登记。
- generation 相同且 worker/Bot 相同是同一 delivery 的幂等 PATCH。
- incoming `deliveryEpoch` 必须等于当前 `routing.deliveryEpoch`。
- generation 严格更新时，新 active delivery 可接管；claim job 可换 Bot，pinned job 仍只能
  用原 Bot。
- 新 generation 仍绑定同一 Bot 且 assignment 未被清理时，可以复用该 Bot 的
  running/ready/uncertain prerequisite；shared→pinned continuation 也复用。
- 任何清 assignment/退回 shared 的转换都递增 deliveryEpoch，并把 cabinetFriendship
  重置为 pending；之后即使又选回同一 Bot，也会生成新 idempotency key。
- generation 更旧，或同 generation 但 worker/Bot 不同，返回 `409 stale_execution`。
- terminal job 不接受新的 execution 或普通 worker PATCH。

worker 必须监听 `lockRenewalFailed`，并把 AbortSignal 传到 prepare、DXNet request、等待和 PATCH；
失去 BullMQ lock 后不再发起新操作。BullMQ 无法强制终止已经发出的外部请求，因此 addRival 和
cleanup 等副作用仍必须按 at-least-once 设计。

## 4. addRival 幂等

`addRival` 是外部副作用，worker 可能在 cabinet 已成功、backend 尚未记录结果时死亡。设计必须
假设同一 prerequisite 可能执行多次。

幂等 key：

```text
dxnet:<jobId>:delivery:<deliveryEpoch>:bot:<botFriendCode>:add-rival
```

backend/sdgb job enqueue 规则：

- 同 key 已有 queued/processing：返回同一个 sdgb job 并继续等待。
- 同 key 已 completed，且 Bot 与当前 execution 一致：两个非负 return code 只记录观测并复用
  ready；任一为 adapter sentinel -1 时按 invalid_response 进入 uncertain。
- 同 key failed 且 `outcomeUnknown=true`：标记 prerequisite uncertain，不再次发送 mutation，
  交给 DXNet friend search/handler 或 QR fresh snapshot 验证。
- 只有能确认 mutation 尚未开始的 enqueue/backend 失败才允许重试同 key。
- 同一 deliveryEpoch 被同一 Bot 重新拿到时复用原 key；由另一个 Bot 接管时使用该 Bot
  对应的新 key。

cabinet API 本身不接受 idempotency key；backend 的 key 只防止同一 execution 的重复 prepare
创建多个 sdgb job，不能把 outcome unknown mutation 当成安全可重放操作。

实现上给 backend `sdgb_jobs` 增加 nullable `idempotencyKey` 和 partial unique index（仅索引
string 值）。`SdgbJobDispatcher.addRival()` 接收该 key，使用原子 upsert/find-existing；并发
duplicate-key 时重新读取现有 row。现有 `requesterTag` 只用于观测，不能充当幂等约束。sdgb
job 的 24h TTL 大于单次 DXNet delivery 和 6h background deadline，足以覆盖同一
deliveryEpoch/Bot 的重试窗口。

当前 `waitForCompletion()` 在 failed 时只抛字符串，会丢失 `outcomeUnknown/failureClass/jobId`。
新增返回完整 completed/failed view 的 `waitForTerminal()`；prepare 必须基于结构化 terminal view
分类，不能解析 error message。现有需要 throw-on-failed 的调用方可继续由 dispatcher 包一层 typed
error，但 typed error 必须携带上述字段。

## 5. Worker 死亡后的好友清理

最危险窗口：

```text
Bot A addRival 成功
  -> worker A 死亡
  -> job 被 Bot B 接管并 addRival
```

此时 A、B 都可能暂时保留目标好友，但不需要新增 friendship collection、cleanup queue 或独立
reconciler。复用现有 worker `CleanupService`：它每 5 分钟拉取 Bot 全量好友列表，从 backend
取得该 Bot 的非终态 active friend codes 和 QR-login 保护名；不再 active 的 cabinet-bound
用户会被驱逐，好友数超过 soft limit 时也会继续清理。

处理规则：

- 首次 execution PATCH 必须在 addRival 前写入当前 `botUserFriendCode`，因此正常执行期间现有
  active-friend-codes 查询会保护该关系。
- job 被 Bot B 接管后，Mongo 的当前 Bot 改为 B；目标用户不再出现在 Bot A 的 active 列表，
  A 的下一轮周期清理会移除孤儿关系。
- 不在 Job terminal 后异步直接 remove；否则紧接着创建的同用户 Job 可能先建立 active
  relationship，随后被上一 Job 的延迟 remove 删除。统一由周期清理在读取 active friend codes
  后执行。
- job canceled/failed 后自然退出 active 列表；无需额外 cleanup 状态机。
- 旧 Bot 离线时不做跨主机清理；它恢复上线后的下一轮 CleanupService 再处理。
- assignmentMode=claim 与 pinned 关系都服从现有周期 CleanupService。QR identity 在完成
  name/rating 反查前由运行中的 attempt rivalName 保护。

## 6. 错误分类

| 错误 | interactive | background |
| --- | --- | --- |
| backend/Redis 临时不可用 | 5s 指数退避、上限 60s，受 deadline 限制 | 同左 |
| sdgb enqueue 在 mutation 前失败 | 5s 后重试同 idempotency key | 指数退避、上限 30min |
| sdgb `outcomeUnknown=true` | 不重发 addRival；尝试 DXNet 验证，失败返回 `cabinet_friendship_unconfirmed` | 不重发；验证失败 30min 后创建新 execution |
| BullMQ lock renewal 失败 | abort 当前 handler，等待 stalled redelivery | 同左 |
| Bot cookie expired | PATCH queued，5-10s jitter 后重新投递 | 同左 |
| Bot 无 cabinet binding | 本次 execution 不合格，delay 后换 worker | 同左 |
| Bot snapshot 过期、friendCount >= 50 或 backend effectiveFriendLoad >= 80 | 检查期间暂停 shared consumers；当前 job 进入 5-10s jitter 后重新竞争 | 同左 |
| DXNet 验证未形成好友 | `cabinet_friendship_unconfirmed`，提示好友申请 fallback | 30min 后重试新 execution |
| deadline 超时 | `job_deadline_exceeded` | cancel/coalesce，不再执行陈旧任务 |
| job canceled | prepare/handler 都停止；已产生关系进入 cleanup | 同左 |

## 7. Queue repair

现有 repair 逻辑按 `botUserFriendCode` 补 per-bot queue。新逻辑必须先检查目标 routing 对应的
BullMQ job 状态：waiting、delayed 或 active 均不重复投递；active lock 的恢复交给 BullMQ
stalled checker。确认 BullMQ job 缺失后，backend 才执行一次带 Mongo CAS 的 repair：

```text
非终态 Mongo job + BullMQ job 缺失
  -> routing.deliveryEpoch += 1
  -> status = queued
  -> deliveryMode=shared：claim job 清 botUserFriendCode，enqueue shared lane queue
  -> deliveryMode=pinned：保留 botUserFriendCode，enqueue pinned bot lane queue
  -> payload = { jobId, deliveryEpoch }
```

BullMQ delivery id 使用确定格式 `<mongoJobId>-e<deliveryEpoch>`，同 queue/epoch 重试仍能去重，
handoff/repair 的新 epoch 则不会被旧 completed/failed row 阻挡。所有 QueueEvents handler 必须从
delivery id 解析 epoch，并以 `{ id: mongoJobId, "routing.deliveryEpoch": epoch }` 做 CAS；旧 epoch
迟到的 failed/stalled event 只记审计，不能改写当前 Mongo job。

`BotStatusService.cleanupStaleJobs()` 按 assignmentMode 分流：claim job 即使当前
`deliveryMode=pinned`，也改回 shared、queued、清 `botUserFriendCode` 并递增 epoch，由 shared
delivery/repair 接管；原生 pinned job 保留 Bot
并等待其恢复，超过 deadline 后才以 `cabinet_bot_unavailable` 终结。不能让 5 分钟 heartbeat
timeout 绕过 v2 的重路由语义。

## 8. Timeline 与审计（后续补齐）

当前已记录 `route_selected` 和通用状态/阶段变化。以下细粒度 event 尚未全部实现，后续补齐：

```text
route_selected
execution_registered
execution_reassigned
execution_rejected_stale
bullmq_lock_renewal_failed
cabinet_prepare_started
cabinet_prepare_ready
cabinet_prepare_failed
```

所有 event 至少记录：`jobId`、`source`、`lane`、`workerId`、`botFriendCode`、
`deliveryEpoch`、`attemptsStarted`、`queueWaitMs`、`errorClass`。
