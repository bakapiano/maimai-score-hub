# 迁移、测试与上线

## 1. 分阶段迁移

### Phase 0：维持止血

- 自动 FC/FS enrichment 保持关闭，避免继续批量 addRival。
- worker concurrency 保持保守值。
- 继续监控 Bot friendCount、BullMQ active、stalled 和 addRival 速率。

### Phase 1：数据模型和 claim API

- 新增 routing、claim、cabinet prerequisite 字段。
- 实现原子 claim、lease heartbeat、token fencing。
- worker 支持 shared lane consumer，但 feature flag 默认关闭。
- legacy pinned queue 行为不变。

feature flags：

```text
DXNET_SHARED_LANES_ENABLED=false
DXNET_WORKER_CLAIM_ENABLED=false
DXNET_WORKER_PREPARE_CABINET_ENABLED=false
```

### Phase 2：后台 recent event 试点

- 恢复少量 auto-update FC/FS producer，但只创建 background claim job。
- worker claim 后才 addRival。
- 限制 allowlist 用户、低 batch；canary 从 background concurrency=1 起步。
- 验证稳定后升到 target：background lane=16、`get_user_recent_event` per worker=2、
  background `update_score` per worker=1。
- producer 必须限速平滑释放，不能恢复历史一次批量 enqueue 数百个 due user 的行为。
- 验证好友关系创建到真正 DXNet 使用之间的时间显著缩短。

### Phase 3：手动 update_score

- cabinet-bound 且无现成 snapshot 的手动同步改走 user_sync claim queue。
- API 创建不再同步等待 sdgb。
- 前端支持 queued/preparing 状态和 structured prerequisite failure。
- 现成好友 snapshot/proof 仍走 pinned fast path。
- canary 先使用 `user_sync=8`；确认 lock renewal 和上游错误率稳定后升到固定 target 16，
  目标 queue wait p95 < 1s。

### Phase 4：QR login

- QR slow path 改为 interactive claim job。
- worker claim 后 addRival、抓 snapshot；backend 使用最终 Bot 完成反查。
- 移除 QR service 中提前 `pickAvailableCabinetBot()` 和直接 addRival。

### Phase 5：清理 legacy

- queue repair 完全理解 shared/pinned lane。
- 移除 `JobService.create()` 中同步 cabinet fast-path。
- 删除不再使用的 backend 预选 Bot 分支。
- 根据数据决定是否迁移所有 pinned queue 到 lane-aware queue。

## 2. 单元测试

### Routing

- source/jobType 正确映射 lane、priority、assignment mode。
- 同一 `update_score` 在 user 和 auto source 下进入不同 lane。
- existing snapshot/proof 生成 pinned job；cabinet-only 生成 claim job。

### Claim

- 两个 worker 并发 claim 只有一个成功。
- 不可用、expired、无 cabinet binding、好友满的 Bot 被拒绝。
- token/attempt fencing 拒绝旧 worker PATCH。
- lease 过期后另一个 worker可接管。
- pinned job 拒绝错误 Bot。

### Prepare

- worker prepare 不接收/返回 cabinet id。
- 重复 prepare 复用相同 idempotency key/sdgb job。
- addRival success/已存在均归一化 ready。
- transient/permanent error 进入不同 retry 路径。
- job canceled 后 prepare 不再产生新 sdgb job。

### Concurrency

- 三条 lane 使用独立、固定 concurrency，不实现动态 borrow/burst。
- background lane 满载时不能占用 interactive 或 user_sync 的 slot。
- interactive lane 固定 8 个 slot，background lane 固定 16 个 slot。
- user_sync 16 个 slot 全部可由用户手动同步使用。
- 每条 lane 和每个 job type 都不能突破对应固定上限。
- job type semaphore 满时 delivery 被 delay，而不是长期 active 等待。
- 多 lane consumer 共享 addRival/request limiter。

## 3. 集成测试

1. 三个 worker 同时消费 shared queue，验证实际 claimant 决定
   `botUserFriendCode`。
2. worker 在 addRival 前死亡，job 被另一 worker claim，旧 token 无法写状态。
3. worker 在 addRival 后、ready 落库前死亡，重试不会无限创建 sdgb jobs。
4. backend 双副本同时处理 claim/prepare，Mongo 原子条件仍正确。
5. Redis/BullMQ 重启后 queue repair 只补正确 lane。
6. interactive、user_sync、background 同时积压，验证交互 job p95 不随 background depth
   线性增长。
7. cleanup/reconciliation 能移除旧 claim 产生的孤儿临时好友。

## 4. 关键指标

```text
dxnet_queue_wait_seconds{lane,jobType,source}
dxnet_queue_depth{lane,state}
dxnet_active_jobs{workerId,botFriendCode,lane,jobType}
dxnet_claim_total{lane,result,reason}
dxnet_claim_lease_expired_total{lane}
dxnet_claim_reassignment_total{fromBot,toBot}
dxnet_job_type_semaphore_wait_seconds{jobType,source}
dxnet_cabinet_prepare_seconds{source,result}
dxnet_cabinet_prepare_retry_total{source,errorClass}
dxnet_interactive_deadline_missed_total{jobType}
dxnet_temporary_friend_leases{botFriendCode,state}
dxnet_orphan_friend_cleanup_total{result}
```

sdgb 侧同时看：

```text
sdgb_queue_wait_seconds{lane,jobType,trafficClass}
sdgb_add_rival_total{trafficClass,result}
sdgb_add_rival_rate_wait_seconds{trafficClass}
```

## 5. 上线门槛

进入下一阶段前至少满足：

- interactive queue p95 wait 在目标内，background 压测时不明显恶化。
- claim 冲突、旧 token 写入均被正确拒绝。
- 没有同一 job 在两个 Bot 同时运行 DXNet handler。
- addRival 次数接近真正执行 cabinet-assisted job 数，而不是 producer 创建数。
- Bot friendCount 不再随 background backlog 快速增长。
- worker restart/stalled 后 job 可恢复，且孤儿临时好友有可验证 cleanup 路径。

## 6. 回滚

- producer flag 可立即停止创建 shared claim job。
- 已创建 shared job 可暂停 lane consumer，不影响 legacy pinned queues。
- 回滚代码前先让 shared jobs drain 或批量转回 queued，再由迁移工具按 routing version 重投。
- 不允许简单删除 BullMQ keys而不处理 Mongo 非终态 job；否则 repair 会重新补投或留下永久
  processing。
