# 测试、发布与运维

[← 返回总览](./README.md)

## 1. 测试原则

所有自动化测试使用 fake `UpstreamAdapter`，通过可编程响应模拟成功、空响应、超时、连接中断、结果不明确和 cleanup。测试不得访问真实外部服务，不需要任何外部地址、凭据或协议实现。

Fake adapter：

```ts
interface FakeUpstreamScenario {
  response: "success" | "empty" | "timeout" | "network" | "invalid";
  latencyMs?: number;
  sideEffectApplied?: boolean;
  sessionOpened?: boolean;
  cleanupSucceeds?: boolean;
}
```

## 2. 单元测试

### 2.1 Registry/Eligibility

- heartbeat 写入与 TTL；
- workerClass 静态校验；
- stale worker 排除；
- capability/active lane 校验；
- drain worker 排除；
- blocked worker 排除；
- version 不兼容排除；
- preference/load 确定性排序；
- Probe 优先 Recoverable、Interactive 优先 Stable；
- 首选 class 全部不 eligible 时才跨 class failover；
- 网络 failover 候选公网 IP 必须不同。

### 2.2 Lease/Fencing

- 单 owner acquire；
- compare-and-renew；
- 错 token/epoch renew 失败；
- 旧 owner compare-and-delete 不影响新 owner；
- lease lost 本地 pause；
- 旧 epoch terminal update 被拒绝；
- Redis 错误 fail closed。

### 2.3 Rate Limit

- Recoverable 不产生软件 QPS token wait，但 concurrency 有界；
- Recoverable breaker open 后不再发新请求并触发 Auto Recovery；
- Stable 同一进程所有 lane 共享 strict global budget；
- Stable Interactive/Probe type bucket 相加不突破 global；
- Stable burst=1 间隔；
- Stable Interactive/cleanup 保留容量；
- Stable 有 Interactive waiter 时 Probe 不能继续占用保留 token；
- cancel/lease lost 可中止 Stable token wait。
- 两个 live worker 报告相同 publicIp 时被判定为部署冲突。

### 2.4 Circuit Breaker

- 只统计 transport empty；
- 连续阈值 open；
- open 后禁止新调用；
- half-open 单并发；
- 连续成功 close；
- half-open 失败 reopen；
- 多 worker 共享 breaker。

### 2.5 Retry/Cancel

- Retry 使用同 jobId；
- retryAt/delayed 一致；
- cancel 阻止新 attempt；
- waiting job 不被 repair 复活；
- read-only active abort/requeue；
- side-effecting outcome unknown；
- session cleanup 后 canceled；
- execution token 解决 complete/cancel 竞态。

## 3. Redis/BullMQ/Mongo 集成测试

使用隔离 prefix 和测试数据库启动：

- 两个 Probe-capable worker 竞争 exclusive lease，只允许一个消费；
- Primary drain 后 standby 接管同一 waiting queue；
- Probe 从 Recoverable 切到 Stable；Interactive 从 Stable 切到 Recoverable；
- Stable 承接 Probe backlog 时 Interactive 延迟保持在目标内；
- Active job abort 后由 standby 使用同 jobId 完成；
- 旧 worker 暂停后恢复，fence 阻止继续；
- Queue repair 尊重 lane、retryAt、cancel 和 active execution token；
- Backend 两副本并发发起相同 command，只有一次状态转换；
- Worker heartbeat/command stream 在进程重启后恢复；
- `role=all` 的多个 consumer 共享同一进程预算。

## 4. MaintenanceHook 测试

Hook 使用 fake 实现，验证解耦：

| 场景                                | 预期                                 |
| ----------------------------------- | ------------------------------------ |
| standby 未 active                   | Hook 不被调用。                      |
| Hook 在执行前失败                   | Abort maintenance，恢复 primary。    |
| Hook accepted 后进程断开            | 进入 verification，不盲目重复 hook。 |
| 基础连接恢复但 upstream health 失败 | 保持 standby owner。                 |
| 验证成功                            | 执行 handback。                      |
| Handback 失败                       | 保持 standby，不产生双 owner。       |

路由器重启 adapter 只需要通过该通用 contract 的 adapter 测试；设备协议本身不进入本仓库测试。

## 5. Chaos 测试

至少覆盖：

1. Primary 在领取 job 前退出。
2. Primary 在请求中退出。
3. Primary 已成功但 terminal patch 前退出。
4. Lease renew 时 Redis 短暂不可用。
5. 旧 worker stop-the-world 超过 lease TTL 后恢复。
6. Standby activation 时 Backend owner 切换。
7. Breaker open 同时有大量 waiting Probe job。
8. Maintenance orchestrator 在每个阶段退出并重启。
9. Hook 执行后网络长期不恢复。
10. 新出口恢复但 health check 连续空响应。
11. Interactive active job 与 Probe handoff 同进程并发。
12. Session cleanup 与 worker shutdown 并发。
13. Recoverable breaker open、Stable 接管、Auto Recovery hook、健康验证、Probe handback 完整链路。

每个场景断言：无双 owner、无未限流调用、无 job 静默丢失、无敏感日志。

## 6. 发布阶段

### Phase 0：Schema 与观测

- 增加 lane/routingVersion、attempt/retry、cancel metadata。
- Heartbeat 增加 workerClass、capabilities、activeLanes、publicIp/networkEpoch、version、health、recovery/limiter 状态。
- Admin/metrics 只观测，不改变消费。

验收：当前生产行为不变，Registry 数据稳定。

### Phase 1：Worker Class 与请求策略

- 配置并展示 Recoverable/Stable class。
- Recoverable 使用有限并发 + breaker，不启用 QPS limiter。
- Stable 启用 strict global + job-type limiter。
- Stable 增加 Interactive 保留容量与 Probe best-effort 调度。
- 部署检查阻止同一 publicIp 两个 live worker。
- Worker 发布使用 stop-start，不使用同 IP start-first。

验收：Recoverable 无 token 节流但 breaker 有效；Stable 不突破 global 且 Probe 不影响 Interactive；重复 publicIp worker 不 eligible。

### Phase 2：Lane Lease Observe-only

- Worker 仍按当前配置消费。
- 控制面计算“应当 owner”，记录冲突但不 pause。
- 演练 lease acquire/renew/release 和 stale detection。

验收：连续观察期没有双候选或错误 failover。

### Phase 3：Probe Exclusive Owner

- Primary 使用 lease 控制本地 Probe consumer。
- Recoverable 作为 Probe 首选；Stable 注册 Probe capability 并保持 standby。
- 手工执行无 hook 的 drain/handoff/handback。

验收：同一 queue、同一 jobId 在 handoff 前后连续处理。

### Phase 4：通用 MaintenanceHook

- 接入 maintenance request 状态机。
- 先使用 no-op/sleep hook 演练。
- 再为 Recoverable 接入路由重启 adapter；adapter 只实现 hook contract。
- 先人工触发，再启用定时任务。

验收：Hook 只在 standby active 后运行；验证失败保持 standby。

### Phase 5：Empty Breaker 与 Probe Retry

- 先 shadow 统计 empty threshold。
- 启用 breaker open 但只报警。
- 启用 pause/release/standby takeover。
- Recoverable 接管完成后触发 Auto Recovery；Stable 仅 failover/报警。
- 最后启用 Rival/Map 同 jobId 重投。

验收：模拟空响应不会形成请求风暴，standby 完成 read-only job。

### Phase 6：主动 Cancel

- Waiting/delayed cancel。
- Probe AbortController/requeue。
- Side-effect outcome unknown。
- Session cleanup-aware cancel。

验收：各 job type 满足 [取消语义](./05-cancellation-job-semantics.md)。

### Phase 7：可选扩容

- Interactive 多 active；或
- Probe shard PoC。

只有容量指标证明单 owner 不足时进入。

## 7. Feature Flags

```text
SDGB_REGISTRY_V2_ENABLED
SDGB_WORKER_CLASS_ROUTING_ENABLED
SDGB_STABLE_RATE_POLICY_ENABLED
SDGB_LANE_LEASE_ENABLED
SDGB_MAINTENANCE_CONTROL_ENABLED
SDGB_WORKER_BREAKER_ENABLED
SDGB_PROBE_RETRY_ENABLED
SDGB_ACTIVE_CANCEL_ENABLED
```

Flag 必须有环境默认、owner 和删除日期。Roll back 时禁止同时保留两个 authoritative limiter 或 owner 机制。

## 8. Rollback

- Registry/metrics 可独立关闭，不影响 job。
- Request scheduler rollback 前必须保持一个公网出口一个进程，并验证 type bucket 不会突破 global。
- Worker class routing rollback 前必须固定唯一 owner，并停止自动跨 class failover。
- Lane lease rollback 时先 drain standby，确认唯一当前 worker，再关闭 lease enforcement。
- Maintenance hook 失败可停用定时入口，保留手工控制面。
- Breaker/retry rollback 时 delayed job 必须显式 drain 或失败，不能遗留永久 queued。
- Cancel rollback 不得清除已存在 cancelRequestedAt；旧代码必须在发布前停止领取这些 job。

## 9. SLO 与验收指标

| 项目                                            |  初始目标 |
| ----------------------------------------------- | --------: |
| 计划内 handoff（不含 hook）                     | p95 < 30s |
| 非计划 Probe failover                           | p95 < 45s |
| 双 owner 时间                                   |         0 |
| 计划内维护 job 丢失                             |         0 |
| Breaker open 后新增普通调用                     |         0 |
| Interactive 因 Probe handoff 增加的 p95 延迟    |      < 1s |
| Stable 承接 Probe 时 Interactive 保留容量被突破 |         0 |
| Read-only retry 最终完成率（有健康 standby）    |     > 99% |
| Outcome unknown 被自动盲重试                    |         0 |
| Session cancel 跳过 cleanup                     |         0 |

## 10. 运维 Runbook

### 10.1 计划内网络维护

1. 创建 maintenance request。
2. 查看 selected standby 与 eligibility。
3. 等待 `hookMayRun=true`。
4. Orchestrator 执行 MaintenanceHook。
5. 查看 recovery verification。
6. 成功后 handback；失败保持 standby 并报警。

### 10.2 Worker 故障

1. 确认 heartbeat stale 和 lease epoch 已变化。
2. 确认 standby active。
3. 检查 stalled/retry/cancel job。
4. 旧 worker 恢复后保持 standby，检查版本与 upstream health。

### 10.3 出口空响应

1. 查看 worker breaker 和连续计数。
2. 确认该 worker 新调用已停止。
3. 查看 lane owner 是否切到公网 IP 不同的 worker。
4. 查看 Probe retry 成功率。
5. 原出口只通过显式 half-open verify 恢复。

### 10.4 添加机器

1. 部署相同版本。
2. 配置唯一 workerId/workerClass/capabilities/preference，并确认使用独立公网出口。
3. Recoverable 配置 Auto Recovery hook；Stable 配置 strict rate policy。
4. 确认 Registry healthy，activeLanes 为空。
5. 执行一次 drain/handoff dry-run。
6. 验证 class priority、限流/并发、fence、日志和 rollback。
7. 加入正式候选。

## 11. 发布前检查

- [ ] 文档和代码不包含任何外部地址、凭据、密钥或加密细节。
- [ ] Fake adapter 覆盖所有失败分类。
- [ ] Redis lease/command 原子脚本有单元和并发测试。
- [ ] Worker/Backend 多版本滚动顺序已演练。
- [ ] Probe/Interactive 的 workerClass 优先级与跨 class failover 已覆盖。
- [ ] Stable 的 Interactive 保留容量在 Probe backlog 压测中有效。
- [ ] Recoverable 的 Auto Recovery 只在 standby active 后执行。
- [ ] MaintenanceHook 与 Failover 核心无设备实现依赖。
- [ ] Drain、breaker、cancel、lease lost 共用一致 active job coordinator。
- [ ] Admin 能解释 worker 不 eligible 的具体原因。
- [ ] 所有日志通过敏感信息扫描。
- [ ] Router adapter 定时启用前完成至少一次 no-op 和一次人工维护演练。

## 12. 待确认问题

- Recoverable 各 job type 的安全 concurrency 上限是多少？
- Stable global/job-type QPS 与 Interactive 保留容量如何按生产流量收敛？
- Recoverable 恢复后，Probe 自动 handback 需要多长稳定观察期？
- Interactive 何时从单 active 提升为多 active？
- 是否需要独立 `session` lane，还是继续作为 Interactive capability？
- Probe 单 owner 的最大安全 backlog/时延阈值是多少？
- MaintenanceHook observation 由 orchestrator 主动提交还是控制面轮询？
- UpstreamHealthCheck 的连续成功数和冷却参数如何通过生产数据收敛？
- 公网 IP 变化是否仅用于观测，还是参与 handback policy？默认建议只作为观测，最终以健康验证为准。
