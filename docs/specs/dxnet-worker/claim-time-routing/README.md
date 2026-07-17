# DXNet Claim-Time Routing 与 Worker-Side addRival

本目录定义 DXNet job 从“backend 预选 Bot、同步执行 `addRival`、再投递到
per-bot queue”迁移到“job 先排队、worker claim 后绑定 Bot、再执行 cabinet
prerequisite”的目标设计。

本目录是**目标态 proposal**。在实现和 rollout 完成前，以下文档仍描述当前生产行为：

- [../job-pick-execution-flow.md](../job-pick-execution-flow.md)
- [../../user-activity/non-auto-update-job-flow.md](../../user-activity/non-auto-update-job-flow.md)
- [../../auto-update/pipeline-design.md](../../auto-update/pipeline-design.md)

## 背景

当前 `update_score` cabinet fast-path、QR login slow path、自动更新 FC/FS
enrichment 都会先在 backend 选择一个 Bot，再同步调用 sdgb `addRival`，最后创建
或投递一个绑定该 Bot 的 DXNet job。这个顺序有几个问题：

- Bot 在真正有执行槽位前就被强制分配，排队期间 Bot 可能过期、下线或已经变忙。
- `addRival` 成功后 DXNet job 仍可能长时间排队，临时好友关系提前占用容量。
- backend HTTP 请求会等待 sdgb job，用户请求延迟和 cabinet 链路耦合。
- 所有 job 共享同一类 worker concurrency；BullMQ priority 只能排序 waiting job，不能
  抢占已经 active 的长耗时 `update_score`。
- 自动更新生产的低优先级任务可能同时占满 Bot 和 worker slot，阻塞登录、好友申请、
  QR login 等交互链路。

## 核心结论

1. **需要 cabinet friendship 的 job 不在创建时选择 Bot。** 它们进入 shared lane
   queue，`botUserFriendCode` 初始为 `null`。
2. **哪个 DXNet worker claim，哪个 Bot 成为该次执行 Bot。** claim 必须由 backend
   原子确认，不能只相信 BullMQ delivery。
3. **worker 在执行 handler 前触发 prerequisite。** worker 调 backend 的 prepare
   endpoint；backend 根据 claimant Bot 和目标用户解析 cabinet id，enqueue sdgb
   `add_rival` 并等待结果。
4. **DXNet worker 不直接持有 cabinet id 或 sdgb 协议秘密。** 真正的 cabinet 调用仍由
   sdgb-worker 执行。
5. **保留 pinned route。** 必须提前知道 Bot 的流程，例如用户要向指定 Bot 主动发送好友
   请求，继续进入该 Bot 的 queue；不强行改成 shared claim。
6. **lane 隔离优先于单队列 priority。** 用户交互、用户手动同步、后台自动更新使用独立
   BullMQ queue 和独立 worker concurrency；job type 再用本地 semaphore 限流。

## 文档

- [01-architecture.md](./01-architecture.md)：目标职责、claim/prepare 流程和各业务路径。
- [02-queues-priority-concurrency.md](./02-queues-priority-concurrency.md)：BullMQ lane、
  priority 和 per-type concurrency。
- [03-state-failure-idempotency.md](./03-state-failure-idempotency.md)：Mongo 状态、lease、
  at-least-once、副作用与清理。
- [04-migration-testing-rollout.md](./04-migration-testing-rollout.md)：兼容迁移、测试、指标和
  上线顺序。

## 非目标

- 不把 sdgb 协议实现移动到 DXNet worker。
- 不要求一次迁移所有现有 per-bot queue。
- 不把 BullMQ 当业务 source of truth；MongoDB `jobs` 仍保存业务状态。
- 不承诺 exactly-once。目标是在 at-least-once 下让 claim、prepare 和 cleanup 可恢复、
  可观测、尽量幂等。
