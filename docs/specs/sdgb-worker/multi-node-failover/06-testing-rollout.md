# 测试与上线

[← 返回总览](./README.md)

## 1. 测试原则

所有测试使用 fake `UpstreamAdapter`，模拟 success、empty、timeout、network error、outcome unknown 和 cleanup。不得访问真实外部服务。

多 member 测试至少使用：

```text
2 Recoverable
2 Stable
preferredActiveCount = 2
fallbackActiveCount = 2
```

这样可以覆盖真实分流、单 member 故障和整类故障，而不是只验证 count=1 的兼容路径。

## 2. 单元测试

### Registry/Selection

- Heartbeat TTL/stale。
- Worker class/capability 校验。
- Recoverable hook kind 存在且可解析；Stable 拒绝 hook kind。
- Probe 选择最多配置数量的 Recoverable。
- Interactive 选择最多配置数量的 Stable。
- Preferred active count 低于目标但大于 `0` 时，fallback 仍 inactive。
- Preferred active count 为 `0` 时，fallback 才进入 desired set。
- Preferred 恢复后 fallback 先 pause 新 claim，再 drain。
- Public IP 冲突排除。
- Blocked/draining/version 不兼容排除。
- 现有健康 member 优先保留，确定性排序不抖动。

### Membership/Fencing

- 同一 lane 的多个 desired worker 可分别 acquire。
- 非 desired worker acquire 被拒绝。
- 每个 member key 独立 compare renew/delete。
- 一个 member 过期不删除或 pause 其他 member。
- Membership epoch/generation/networkEpoch 变化使旧 token 失效。
- Worker 重新加入获得新 epoch。
- 旧 executionToken terminal patch 被拒绝。

### Stable Scheduler

- 每个 Stable root global 不突破 1.5 QPS。
- 每 worker 的 job-type ceiling。
- 大量 Probe waiter 后 Interactive 获得该 worker 下一个 token。
- Interactive 无 waiter 时 Probe 借用本 worker 空闲容量。
- Probe concurrency cap 保留连接/semaphore slot。
- maxConsecutiveProbe=1。
- 两个 Stable 的 aggregate 容量可达到两份独立 limiter，但任一单 worker 不超限。

### Recoverable

- 无 QPS token wait。
- 每 worker 的 type concurrency 不突破配置。
- 两个 member 可同时处理不同 job。
- 10 秒 3 empty 只打开故障 worker breaker。
- Breaker open 后该 worker request gate 关闭，其他 worker 继续。
- Auto Recovery 只在非目标 coverage ready 后执行。
- 每 worker 30 分钟 recovery budget。

### Retry/Shutdown

- Rival/Map 同 jobId requeue 并可被另一 member claim。
- RetryAt/BullMQ delayed 一致。
- Drain abort/requeue read-only。
- Add outcome unknown。
- Session cleanup/cleanup handoff。
- `blocked` 阻止 deployment force kill。
- 只 pause 目标 worker 本地 consumer，不触发 BullMQ global pause。

## 3. 集成测试

- 两个 Probe member 共享同一个 queue，二者都持续获得 job。
- 两个 Interactive member 共享同一个 queue，单 job 只被一个 worker claim。
- 一个 Recoverable 退出，另一个继续消费；Stable 不激活 Probe。
- 全部 Recoverable 退出，Stable member set 接管 Probe。
- Recoverable 恢复 active 后，Stable 停止 Probe 新 claim并安全 drain。
- 一个 Stable 退出，另一个继续消费；Recoverable 不激活 Interactive。
- 全部 Stable 退出，Recoverable member set 接管 Interactive。
- Probe backlog 下每个 Stable 的用户 job limiter wait 符合 SLO。
- Breaker incident 驱动 target drain、coverage gate、hook gate 和 health gate。
- Backend 双副本只产生一个 desired set，不超过配置数量。
- Redis 重启后 worker 重新注册/acquire，不沿用旧 membership。
- Queue repair 尊重 lane/retryAt/executionToken。

BullMQ 分流验收不要求严格 50/50；在足够多、耗时接近的测试 job 中，每个 active member 都必须处理到 job，且总 claim 数等于 job 数。

## 4. Chaos 测试

1. 多个 Probe member 中一个在请求前、请求中、terminal patch 前退出。
2. 一个 member stop-the-world 超过 membership TTL 后恢复。
3. 全部 preferred member 同时断网，验证 fallback 只在 active count 归零后启动。
4. Preferred member 恢复时注入 fallback drain 延迟，验证 fallback 无新 claim。
5. Stable 正在执行每一种用户 job 时退出或升级，其他 Stable 持续接收 job。
6. Redis renew 对单个 member 短暂失败。
7. Hook accepted 后 orchestrator 重启。
8. 网络恢复但健康检查继续 empty。
9. Stable member set 接管 Probe 时用户 job 持续到达。
10. Graceful deadline 到达但 session 尚未安全 cleanup。

断言：无未授权 member、无 fallback 在 preferred active 时领取新 job、无 job 静默丢失、无重复终态、无用户 job 被普通强杀、无敏感日志。

## 5. 上线步骤

### Step 1：Schema/Heartbeat

- 增加 `sdgb_jobs` 字段和 `sdgb_maintenance_runs`。
- 发布扩展 heartbeat，Registry 和 desired member set 只观测。

### Step 2：Class-specific Scheduler

- 上线 Stable priority-aware scheduler。
- 压测 Interactive 优先级和 Probe borrowing。
- 启用 Stable strict rate policy。
- 验证 Recoverable concurrency 和 breaker。

### Step 3：Lane Membership

- Observe-only 计算多 member desired set。
- 启用 per-worker membership lease 与 execution fencing。
- 先用 active count=1 验证两条 lane。
- 使用隔离测试配置将 count 提高到 2，验证 BullMQ 实际分流和单 member drain。
- 生产配置明确写入 `preferredActiveCount` 与 `fallbackActiveCount`。

### Step 4：Graceful Upgrade

- 接入 ActiveJobRegistry/AbortController。
- 演练两类 worker 的单 member 升级。
- 验证其他 active member持续消费。
- 验证 drained/cleanup_handoff_ready/blocked。

### Step 5：MaintenanceHook

- 先使用 no-op hook。
- 建立 hook adapter registry 和 idempotent resume。
- 接入 router reboot adapter。
- 演练“另有 preferred member”和“需要 fallback class”两种 coverage。
- 最后启用定时任务。

### Step 6：Empty/Retry

- Shadow 统计 empty。
- 启用 breaker incident。
- 启用 member-scoped drain 和 class failover。
- 启用 Rival/Map 同 jobId retry。

## 6. 已确认参数

| 项目                    | 值                                                                |
| ----------------------- | ----------------------------------------------------------------- |
| Lane active count       | 每 lane/class 可配置正整数；生产初始值可为 preferred 1/fallback 1 |
| Recoverable concurrency | total 16；Rival 8、Map 4、Scan 1、Add 1、Music 2；cleanup 1       |
| Stable rate             | global 1.5/burst 1；Rival 0.95、Map 0.5、Scan 1、Music 1、Add 0.5 |
| Stable Probe            | concurrency 4；max consecutive token 1                            |
| Breaker                 | 10 秒内连续 3 empty；half-open 1；3 success close                 |
| Cooldown                | 1/2/5/10/15 分钟                                                  |
| Preferred restore       | 60 秒 clean window；3 checks；间隔 10 秒                          |
| Auto Recovery           | 每个 Recoverable 最多每 30 分钟一次                               |
| Probe backlog           | oldest 15 分钟 warning；30 分钟 critical                          |

## 7. SLO

| 项目                                                     |                        目标 |
| -------------------------------------------------------- | --------------------------: |
| 单 member 计划内 drain（不含 hook）                      |                   p95 < 30s |
| 需要新增 member 的非计划 failover                        |                   p95 < 45s |
| 未授权 member 领取新 job                                 |                           0 |
| Preferred active 时 fallback 领取新 job                  |                           0 |
| 单 job 重复 terminal                                     |                           0 |
| 单 member 故障导致仍有其他 member 的 lane 停止消费       |                           0 |
| 维护/升级 job 丢失                                       |                           0 |
| Active 用户 job 被普通强杀                               |                           0 |
| Breaker open 后故障 worker 新增普通请求                  |                           0 |
| Probe backlog 导致 Interactive limiter wait（每 worker） | ≤ `1/globalQps` + tolerance |
| Stable 承接 Probe 时任一 worker global 超限              |                           0 |
| Auto Recovery 在非目标 coverage ready 前执行             |                           0 |

## 8. 上线前检查

- [ ] 两类 worker 配置、class priority 和 active count 测试通过。
- [ ] 多个 active member 使用同一个 lane queue 并实际分流。
- [ ] 未授权 worker 无法 acquire membership 或 claim job。
- [ ] 一个 member 失效不影响其余 member key/consumer。
- [ ] Preferred active count 大于 `0` 时 fallback 无新 claim。
- [ ] Stable scheduler 不使用 FIFO promise chain。
- [ ] Stable 限流按 worker/public IP 生效，不误用站点级共享 bucket。
- [ ] Recoverable 不创建 QPS bucket，breaker/concurrency 生效。
- [ ] Graceful upgrade 覆盖全部 job type。
- [ ] MaintenanceHook 与 membership/queue 控制解耦。
- [ ] 两个不同 hook kind 复用同一状态机，requestId 重试不重复创建外部操作。
- [ ] Hook 只在 target drained 且非目标 coverage ready 后运行。
- [ ] DB migration/index 已验证。
- [ ] Worker/Orchestrator API 幂等与鉴权已验证。
- [ ] 所有测试使用 fake adapter。
- [ ] 敏感信息扫描通过。
