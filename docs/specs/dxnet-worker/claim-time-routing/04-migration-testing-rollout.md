# 迁移、测试与上线

## 1. 停机切换原则

本方案不兼容 routing-v1 worker，也不安排新旧 worker 混跑。允许一个短暂的 DXNet worker
停机窗口，换取以下简化：

- Backend 永远创建 routing-v2 job。
- Worker 永远只消费六条 v2 shared/pinned lane queue。
- Worker PATCH 永远要求 `(deliveryEpoch, attemptsStarted)` generation。
- 不保留 legacy per-Bot consumer、legacy PATCH body、`producerMode` 或 standby 模式。
- 切换时仍非终态的 pre-v2 job 统一标记 canceled，不尝试跨协议恢复。

sdgb-worker 不受该停机窗口影响，Probe/Interactive 两条 sdgb lane 继续运行。

## 2. 上线顺序

### 2.1 切换前

1. 先部署能识别 `cabinetFriendshipStatus/errorCode` 和 cabinet binding `202 + polling` 的
   frontend。
2. 构建 backend 与 worker，完成单元测试和本地跨进程 E2E。
3. 确认 Mongo/Redis 可用，并记录旧 queue depth、旧非终态 job 数和 Bot snapshot age。

### 2.2 停机窗口

1. 停止全部 DXNet worker container；不调用 remove-bot，保留 cabinet binding 和 snapshot。
2. 等待最后一次 Bot heartbeat 超过 90 秒，然后使用
   `gh workflow run deploy-backend.yml -f confirm_dxnet_v2_cutover=true`。首次 cutover migration
   会检查显式确认和在线 Bot gate，不满足时拒绝执行。
3. 部署流程先运行 `migrate:dxnet-routing-indexes`：
   - 创建 routing deadline/repair indexes；
   - 创建 `sdgb_jobs.idempotencyKey` partial unique index；
   - 将仍为 queued/processing 的 pre-v2 job 标记 canceled。
4. 两个旧 backend replica 滚动下线后，部署流程再次运行同一幂等迁移，取消滚动窗口内由旧
   replica 创建的少量 pre-v2 job。此后新请求只会创建 routing-v2 job。
5. Backend 上线后，新请求直接进入新 queues；此时暂时没有 consumer，job
   保持 waiting。
6. 使用 `deploy-worker.yml -f target=all` 部署全部 DXNet worker。
7. 等待每台 worker 满足：六个 consumer ready、snapshot age <= 5min、RSS < 70%、
   `RestartCount=0`。
8. 验证 shared/pinned queue 开始下降，且没有新的 pre-v2 job 或旧 queue 被消费。旧 per-Bot
   Redis delivery 不会由 v2 worker 消费；保留到回滚窗口结束后再按旧 queue 名单清理。

停机窗口主要是步骤 1 到步骤 4。期间用户 job 可以创建和排队，但不会执行；不需要 backend
同时理解两代 worker。

## 3. Routing control

Mongo singleton `dxnet_routing_control` 只保留运行期放量配置：

```ts
{
  epoch: number;
  botAllowlist: string[] | null; // null = 全部健康 worker
  enabledClaimFlows: Array<
    "manual_update" | "qr_identity"
  >;
  claimCanaryByFlow: Partial<Record<
    "manual_update",
    string[] | null
  >>;
}
```

记录缺失时默认启用全部三种 claim flow，并允许全部健康 worker。管理端通过
`PATCH /api/admin/dxnet-routing-control` 携带 expected epoch 做 CAS；该控制只改变 claim flow
和 Bot allowlist，不改变协议版本、queue concurrency 或 generation fencing。

## 4. 单元测试

### Routing

- source/jobType 正确映射 lane、priority 和 assignment mode。
- claim 初始 deliveryMode=shared；原生 pinned 始终为 pinned。
- existing snapshot/proof 生成 pinned；cabinet-only 生成 claim。
- snapshot 只有在 5 分钟内才可作为 pinned 依据。
- QR identity 两种 internal purpose 可以初始使用 null friendCode，普通 public job 不允许。
- priority 固定为 0-4，BullMQ 转换严格为 `5-priority`，所有值都是非零 1-5。
- 六个 queue 分别使用 interactive=8、user_sync=16、background=16。
- 不存在 per-type cap、进程级 semaphore 或 active 后本地 waiter。

### Execution fencing

- v2 PATCH 缺少 execution generation 必须拒绝。
- 首次 PATCH 原子登记 BullMQ winner 的 Bot、worker 和 generation。
- queueName、lane、deliveryMode 或 pinned Bot 不匹配时返回 `invalid_route`。
- 同 generation 同 worker/Bot 的 PATCH 幂等；旧 generation 返回 `stale_execution`。
- stalled redelivery 的 `attemptsStarted+1` 可以接管，旧 processor 随后不能写入。
- repair 重建 delivery 前递增 `deliveryEpoch`。
- delivery id 固定为 `<mongoJobId>-e<deliveryEpoch>`，旧 QueueEvents 不能终结新 epoch。
- shared→pinned handoff 原子更新 epoch/status/runAt，并只 enqueue 一个 continuation。

### Cabinet prepare

- prepare 不接收或返回 cabinet id，并校验当前 execution。
- 重复/并发 prepare 复用同一个 idempotency key 和 sdgb job。
- completed addRival 的任意非负 returnCode 组合进入 ready；`-1`/invalid response 进入 uncertain。
- `outcomeUnknown=true` 不重发 mutation，改由 DXNet/snapshot 验证。
- manual 使用 0s/2s/5s friend search；recent-event 使用 3min pinned handoff；QR 使用 post-add
  fresh snapshot。

### Shutdown

- SIGTERM 先暂停六个 consumer。
- 尚未完成首次 execution PATCH 的 processor 立即 requeue。
- background execution 立即 abort/requeue。
- interactive/user_sync 最多 drain 60 秒，进程在 90 秒内关闭。
- AbortSignal 贯穿 backend PATCH、prepare、DXNet request 和 sleep。

## 5. 本地跨进程 E2E

本地 E2E 使用独立 Mongo database 和 Redis/BullMQ prefix，不写 `maimai_web`，并使用 fake
sdgb upstream。当前 DXNet 场景使用测试内 BullMQ consumers 验证 backend routing/fencing，尚未
启动生产 DXNet worker 进程；生产 QueueFleet/processor 由 worker 单测和 Redis smoke 覆盖，完整
fake Maimai upstream 的进程级场景留待后续补充。当前覆盖：

1. 两个 DXNet consumer 竞争同一 shared job，只有一个成为 active winner。
2. 首次 PATCH 绑定 winner；另一个 Bot 的同 generation PATCH 被拒绝。
3. pinned job只进入目标 Bot lane queue。
4. business priority 2/3 分别转换为 BullMQ priority 3/2。
5. 两个并发 prepare 只产生一个带 idempotency key 的 add_rival row。
6. routing control expected-epoch CAS 冲突返回 409。
7. 原有 sdgb lane、active-active、failover、recovery、graceful upgrade 和 fencing 场景继续通过。

## 6. 计划补充的指标

以下指标尚未全部实现，不作为本次停机切换的自动 gate；当前可用信号是 Job timeline、
BullMQ queue state、Bot heartbeat 和 worker 本地 health。后续接入 metrics 时使用这些名称：

```text
dxnet_queue_wait_seconds{lane,deliveryMode,jobType,source}
dxnet_queue_depth{lane,deliveryMode,state}
dxnet_active_jobs{workerId,botFriendCode,lane,deliveryMode,jobType}
dxnet_execution_registration_total{lane,result,reason}
dxnet_stale_execution_patch_total{lane,endpoint}
dxnet_execution_reassignment_total{fromBot,toBot}
dxnet_bullmq_lock_renewal_failed_total{workerId,lane}
dxnet_bullmq_stalled_total{lane}
dxnet_cabinet_prepare_seconds{source,result}
dxnet_cabinet_prepare_retry_total{source,errorClass}
dxnet_cabinet_outcome_unknown_total{source}
dxnet_bot_claim_ineligible_total{botFriendCode,reason}
dxnet_worker_shutdown_seconds{workerId,result}
process_resident_memory_bytes{workerId}
```

sdgb 同时观察：

```text
sdgb_queue_wait_seconds{lane,jobType,priority}
sdgb_add_rival_total{priority,result}
sdgb_add_rival_rate_wait_seconds{priority}
```

## 7. 上线门槛

- 六个 queue 各自 active 不突破 8/16/16；不要求同 lane shared+pinned 合并后仍为该值。
- generation 冲突和旧 generation 写入均被拒绝。
- Bot friendCount < 80；超过 soft limit 50 的持续时间不超过两个 cleanup 周期。
- background 超时 job 已 canceled，且没有超过 deadline 的非终态 row。
- SIGTERM 在 90 秒内 terminal 或安全 requeue。
- 每台 worker 精确上报三条 shared + 三条本 Bot pinned consumer、匹配 revision、snapshot age
  <= 5min、RSS < 70%、RestartCount=0；同一 heartbeat 已进入 backend Bot status。

## 8. 回滚

本方案没有单 worker 或单 backend replica 的协议级回滚：

1. 再次停止全部 DXNet worker。
2. 同时回滚 backend 与全部 worker 到同一旧版本。
3. 切换窗口中创建的 routing-v2 job不能交给旧 worker；按 canceled 处理，由用户或 scheduler
   重新创建。

这是选择停机切换、删除 v1 兼容层后的明确代价。
