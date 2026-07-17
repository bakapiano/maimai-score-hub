# 状态、失败恢复与幂等

## 1. Mongo 仍是业务 source of truth

BullMQ 只保存 delivery。`jobs` 建议新增：

```ts
type AssignmentMode = "claim" | "pinned";
type ExecutionLane = "interactive" | "user_sync" | "background";

interface DxnetJobRouting {
  source: DxnetJobSource;
  lane: ExecutionLane;
  assignmentMode: AssignmentMode;
  requiredCapability: "none" | "cabinet_friendship";
}

interface DxnetJobClaim {
  workerId: string | null;
  botFriendCode: string | null;
  tokenHash: string | null;
  attempt: number;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
}

interface CabinetFriendshipState {
  status: "not_required" | "pending" | "running" | "ready" | "failed";
  botFriendCode: string | null;
  claimAttempt: number | null;
  sdgbJobId: string | null;
  idempotencyKey: string | null;
  completedAt: Date | null;
  lastError: string | null;
}
```

不建议把 `targetCabinetUserId` 暴露到公共 job response。backend 可由 job 的 user identity 在
prepare 时解析。

## 2. 状态转换

claim job 的主要状态：

```text
queued / unassigned
  -> claimed / processing
  -> prerequisite running
  -> prerequisite ready
  -> DXNet handler running
  -> completed
```

重试：

```text
prerequisite transient failure
  -> queued + runAt/backoff + clear expired claim

worker death / BullMQ stalled
  -> claim lease expires
  -> another worker may claim with attempt+1
```

现有 public `status` 可以继续使用 `queued/processing/completed/failed/canceled`；claim 和
prerequisite 细节通过新增字段和 timeline event 表达，不必立即增加 public status enum。

## 3. Claim lease

不能把首次 claim 永久等同于 Bot assignment。worker 可能在 addRival 前后死亡，因此 claim
必须是 lease：

- claim token 只保存 hash。
- lease 短于 job hard timeout，并由 worker 在长 handler 中续约。
- 所有 worker PATCH 检查 token 和 attempt。
- lease 未过期时，其他 Bot claim 返回 `already_claimed`，当前 BullMQ delivery ACK。
- lease 过期后，新的 worker 可将 `attempt` 加一并接管。
- pinned job 只能由同一 Bot 接管；claim job 可换 Bot。

BullMQ lock 仍负责 delivery 级别互斥，Mongo claim lease 负责业务写入 fencing。两者职责不同，
不能只依赖其中一个。

## 4. addRival 幂等

`addRival` 是外部副作用，worker 可能在 cabinet 已成功、backend 尚未记录结果时死亡。设计必须
假设同一 prerequisite 可能执行多次。

幂等 key：

```text
dxnet:<jobId>:claim:<attempt>:add-rival
```

backend/sdgb job enqueue 规则：

- 同 key 已有 queued/processing：返回同一个 sdgb job 并继续等待。
- 同 key 已 completed，且 Bot 与当前 claim 一致：直接复用 ready 结果。
- 同 key failed：按错误分类决定重试或返回失败。
- claim 被新 Bot 接管：新 attempt 使用新 key，对新 Bot 再执行 addRival。

即使 cabinet API 本身没有 idempotency key，重复把同一目标添加为同一 Bot 的 rival 应按“成功
或已存在均视为 ready”归一化。需要在协议返回码 spec 中列出可接受返回码。

## 5. Worker 死亡后的好友泄漏

最危险窗口：

```text
Bot A addRival 成功
  -> worker A 死亡
  -> job 被 Bot B 接管并 addRival
```

此时 A、B 都可能保留目标好友。不能只依赖成功 job 的
`removeFriendAfterComplete`。建议新增 friendship lease/reconciliation：

```ts
{
  parentJobId,
  botFriendCode,
  targetFriendCode,
  claimAttempt,
  state: "created" | "in_use" | "cleanup_pending" | "cleaned",
  expiresAt
}
```

处理规则：

- prerequisite ready 后记录 lease。
- job 正常完成后，若是临时关系，当前 Bot worker执行 remove friend。
- claim 被接管时，旧 lease 标记 `cleanup_pending`。
- 对应 Bot 下次在线时消费自己的 cleanup queue。
- 定期 reconciliation 比较 bot friend snapshot 和有效 lease，清理孤儿临时好友。
- 手动用户同步是否立即删除由产品策略决定；自动任务默认必须清理。

## 6. 错误分类

| 错误 | interactive | background |
| --- | --- | --- |
| backend/Redis 临时不可用 | 短退避，受 deadline 限制 | 指数退避 |
| sdgb timeout/网络错误 | 1-2 次快速重试后失败 | 指数退避 + jitter |
| Bot cookie expired | 清 claim，尽快让其他 worker claim | 清 claim，正常排队 |
| Bot 无 cabinet binding | claimant 不合格，清 claim | claimant 不合格，换 worker |
| Bot 好友容量已满 | claim 拒绝并记录 capacity | 换 worker或延后 |
| cabinet 明确拒绝 | structured failure，可提示好友申请 fallback | 记录 backoff，不热循环 |
| job canceled | prepare/handler 都停止；已产生关系进入 cleanup | 同左 |

## 7. Queue repair

现有 repair 逻辑按 `botUserFriendCode` 补 per-bot queue。新逻辑必须按 routing 字段补投：

```text
assignmentMode=claim && 无有效 lease
  -> shared lane queue

assignmentMode=pinned
  -> pinned bot lane queue

assignmentMode=claim && 有有效 lease
  -> 不补投，等待当前 delivery/lease

lease 已过期
  -> 清 claim，再补 shared lane queue
```

BullMQ job id 继续使用 Mongo job id，保证 repair 不制造同 queue 重复 job。迁移期 queue name
应加入 job routing version，避免同一个 job 同时存在 legacy/new queue。

## 8. Timeline 与审计

新增 timeline event：

```text
route_selected
claim_attempted
claimed
claim_rejected
claim_released
claim_expired
cabinet_prepare_started
cabinet_prepare_ready
cabinet_prepare_failed
friend_cleanup_scheduled
friend_cleanup_completed
```

所有 event 至少记录：`jobId`、`source`、`lane`、`workerId`、`botFriendCode`、
`claimAttempt`、`queueWaitMs`、`errorClass`。

