# 测试与上线

[← 返回总览](./README.md)

## 1. 测试原则

所有测试使用 fake `UpstreamAdapter`，模拟 success、empty、timeout、network error、outcome unknown 和 cleanup。不得访问真实外部服务。

## 2. 单元测试

### Registry/Selection

- Heartbeat TTL/stale。
- Worker class/capability 校验。
- Probe Recoverable → Stable。
- Interactive Stable → Recoverable。
- Public IP 冲突排除。
- Blocked/draining/version 不兼容排除。

### Lease/Fencing

- 单 owner acquire。
- Compare renew/delete。
- Epoch/generation/networkEpoch 变化导致 lease lost。
- 旧 executionToken terminal patch 被拒绝。

### Stable Scheduler

- Root global 不突破 1.5 QPS。
- Job-type ceiling。
- 大量 Probe waiter 后 Interactive 获得下一个 token。
- Interactive 无 waiter 时 Probe 借用空闲容量。
- Probe concurrency cap 保留连接/semaphore slot。
- maxConsecutiveProbe=1。

### Recoverable

- 无 QPS token wait。
- Type concurrency 不突破配置。
- 10 秒 3 empty 打开 breaker。
- Breaker open 后请求 gate 关闭。
- Auto Recovery 只在 standby active 后执行。
- 30 分钟 recovery budget。

### Retry/Shutdown

- Rival/Map 同 jobId requeue。
- RetryAt/BullMQ delayed 一致。
- Drain abort/requeue read-only。
- Add outcome unknown。
- Session cleanup/handoff。
- `blocked` 阻止 deployment force kill。

## 3. 集成测试

- Recoverable/Stable 同时注册，Probe/Interactive owner 正确。
- Recoverable drain → Stable 接管 Probe → handback。
- Stable drain → Recoverable 接管 Interactive → handback。
- Probe backlog 下用户 job limiter wait 符合 SLO。
- Breaker incident 驱动 failover、hook gate、health gate。
- Backend 双副本不会产生双 owner。
- Redis 重启后 worker 重新注册/acquire，不沿用旧 lease。
- Queue repair 尊重 lane/retryAt/executionToken。

## 4. Chaos 测试

1. Probe owner 在请求前、请求中、terminal patch 前退出。
2. Stable 正在执行每一种用户 job 时退出/升级。
3. 旧 worker stop-the-world 超过 lease TTL 后恢复。
4. Redis renew 短暂失败。
5. Router hook accepted 后 orchestrator 重启。
6. 网络恢复但健康检查继续 empty。
7. Stable 接管 Probe 时用户 job 持续到达。
8. Graceful deadline 到达但 session 尚未安全 cleanup。

断言：无双 owner、无 job 静默丢失、无用户 job 被普通强杀、无敏感日志。

## 5. 上线步骤

### Step 1：Schema/Heartbeat

- 增加 `sdgb_jobs` 字段和 `sdgb_maintenance_runs`。
- 发布扩展 heartbeat，Registry 只观测。

### Step 2：Stable Scheduler

- 上线 priority-aware scheduler。
- 压测 Interactive 优先级和 Probe borrowing。
- 启用 Stable strict rate policy。

### Step 3：Lane Lease

- Observe-only 计算 owner。
- 启用 Probe/Interactive exclusive lease。
- 手工 drain/handoff/handback。

### Step 4：Graceful Upgrade

- 接入 ActiveJobRegistry/AbortController。
- 演练两类 worker 升级。
- 验证 drained/cleanup_handoff_ready/blocked。

### Step 5：MaintenanceHook

- 先使用 no-op hook。
- 接入 router reboot adapter。
- 人工执行一次完整 handoff/recovery/handback。
- 最后启用定时任务。

### Step 6：Empty/Retry

- Shadow 统计 empty。
- 启用 breaker incident。
- 启用 Recoverable → Stable failover。
- 启用 Rival/Map 同 jobId retry。

## 6. 已确认参数

| 项目                    | 值                                                                |
| ----------------------- | ----------------------------------------------------------------- |
| Recoverable concurrency | total 16；Rival 8、Map 4、Scan 1、Add 1、Music 2；cleanup 1       |
| Stable rate             | global 1.5/burst 1；Rival 0.95、Map 0.5、Scan 1、Music 1、Add 0.5 |
| Stable Probe            | concurrency 4；max consecutive token 1                            |
| Breaker                 | 10 秒内连续 3 empty；half-open 1；3 success close                 |
| Cooldown                | 1/2/5/10/15 分钟                                                  |
| Handback                | 60 秒 clean window；3 checks；间隔 10 秒                          |
| Auto Recovery           | 每个 Recoverable 最多每 30 分钟一次                               |
| Probe backlog           | oldest 15 分钟 warning；30 分钟 critical                          |

## 7. SLO

| 项目                                        |                        目标 |
| ------------------------------------------- | --------------------------: |
| 计划内 handoff（不含 hook）                 |                   p95 < 30s |
| 非计划 failover                             |                   p95 < 45s |
| 双 owner 时间                               |                           0 |
| 维护/升级 job 丢失                          |                           0 |
| Active 用户 job 被普通强杀                  |                           0 |
| Breaker open 后新增普通请求                 |                           0 |
| Probe backlog 导致 Interactive limiter wait | ≤ `1/globalQps` + tolerance |
| Stable 承接 Probe 时 global 超限            |                           0 |
| Auto Recovery 在 standby active 前执行      |                           0 |

## 8. 上线前检查

- [ ] 两类 worker 配置与 class priority 测试通过。
- [ ] Stable scheduler 不使用 FIFO promise chain。
- [ ] Recoverable 不创建 QPS bucket，breaker/concurrency 生效。
- [ ] Graceful upgrade 覆盖全部 job type。
- [ ] Router hook 与 lease/queue 控制解耦。
- [ ] Hook 只在 standby active 后运行。
- [ ] DB migration/index 已验证。
- [ ] Worker/Orchestrator API 幂等与鉴权已验证。
- [ ] 所有测试使用 fake adapter。
- [ ] 敏感信息扫描通过。
