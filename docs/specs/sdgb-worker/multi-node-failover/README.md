# sdgb-worker 双类型 Worker、多成员分流与 Auto Recovery

状态：Proposed

日期：2026-07-16

本文是可直接进入实现的 sdgb-worker 多节点规格。范围固定为两类 worker、两条支持多 active member 的 lane、空响应隔离与接管、可插拔 Auto Recovery hook、Probe 重投、Stable 用户请求 QoS 和 graceful upgrade。

所有外部调用统一由 `UpstreamAdapter` 抽象。文档不包含外部地址、请求格式、凭据、密钥、加密方式或原始响应。

## 文档导航

- [架构与 Worker/Lane 决策](./01-architecture.md)
- [Worker Registry、Lane Membership 与限流](./02-registry-lane-rate-limit.md)
- [Failover 与 Router Hook 状态机](./03-failover-router-hook.md)
- [Empty Response、重投与 Graceful Shutdown](./04-empty-retry-graceful-shutdown.md)
- [数据库与内部 API](./05-database-and-apis.md)
- [测试与上线](./06-testing-rollout.md)

## 1. 两类 Worker

| workerClass   | 主要职责                     | Auto Recovery                                                   | 请求策略                                    | 可接受性                     |
| ------------- | ---------------------------- | --------------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| `recoverable` | Probe 主力                   | 必须配置 `autoRecoveryHookKind`；故障后执行对应 MaintenanceHook | 不设置软件 QPS 上限；使用有限并发和 breaker | 可接受恢复期间部分 downtime  |
| `stable`      | Interactive 主力、Probe 备用 | 不执行自动网络恢复                                              | 严格 global + job-type 分层限流             | 优先保证用户任务稳定和低延迟 |

每个公网 IP 只运行一个 sdgb-worker 进程。Worker 升级采用 graceful drain-stop-start，不允许同 IP 双进程同时发起外部请求。

## 2. 两条 Lane 与 Active Member Set

| Lane          | Job types                                 | Worker class 优先级      |
| ------------- | ----------------------------------------- | ------------------------ |
| `probe`       | `get_rival_hash`、`get_user_map`          | `recoverable` → `stable` |
| `interactive` | `scan_qr`、`add_rival`、`get_music_score` | `stable` → `recoverable` |

每条 lane 对应一个可包含多个 worker 的 active member set：

```ts
type LanePolicy = {
  preferredClass: WorkerClass;
  preferredActiveCount: number;
  fallbackClass: WorkerClass;
  fallbackActiveCount: number;
};
```

选择规则固定为：

1. 从 healthy、eligible 的 preferred class 中激活最多 `preferredActiveCount` 个成员。
2. 只要 preferred active count 大于 0，fallback class 就不领取该 lane 的新 job。
3. preferred active count 为 0 时，才激活最多 `fallbackActiveCount` 个 fallback 成员。
4. 恢复 preferred coverage 时，先确认 preferred member active，再让 fallback member 停止领取新 job并 drain。

两个 count 都是正整数配置。生产初始值可以是 `1`；实现、Redis 模型、API 和测试必须原生支持大于 `1`，调整数量只改配置。

同一 lane 的所有 active member 消费同一个 BullMQ queue。BullMQ 将不同 job 分配给可用 consumer；单个 job 仍只由一个 worker claim，execution fencing 防止旧进程写回。

## 3. 已确认请求参数

### 3.1 Recoverable（每个 Worker / 公网 IP）

```text
worker total concurrency = 16
get_rival_hash = 8
get_user_map = 4
scan_qr = 1
add_rival = 1
get_music_score = 2
cleanup = 1 independent slot
QPS limit = none
```

Recoverable 不限 QPS，但不允许无限并发、无限重试或 breaker open 后继续请求。增加 Recoverable member 会增加 aggregate concurrency。

### 3.2 Stable（每个 Worker / 公网 IP）

```text
global = 1.5 QPS
burst = 1
get_rival_hash = 0.95 QPS
get_user_map = 0.5 QPS
scan_qr = 1 QPS
get_music_score = 1 QPS
add_rival = 0.5 QPS
probe concurrency cap = 4
max consecutive Probe token = 1
```

Stable 请求调度顺序：

```text
cleanup
> Interactive
> failover Probe
```

Interactive 无 waiter 时 Probe 可以借用空闲 token；Interactive 到达后必须获得该 worker 的下一个 root token。Probe backlog 不得排在 Interactive waiter 前，也不得占满连接或 semaphore。

在 `global=1.5 QPS / burst=1` 且 Interactive 自身未超单 worker 容量时，Probe backlog 给新 Interactive 请求增加的 limiter wait 目标上界约为一个 token interval（约 667ms）加调度误差。

限流按 worker/public IP 独立执行，不增加站点级 distributed limiter。增加 Stable member 会增加 aggregate 1.5 QPS 容量，但每个 IP 仍严格受自己的 global 与 job-type ceiling 约束。

## 4. Empty Response 与 Member Failover

```text
10 秒内连续 3 次 transport empty
→ breaker open
→ 故障 worker 本地 fail closed
→ durable incident + heartbeat blocked/draining
→ 该 worker 上的 Rival/Map 使用同 jobId 重排
→ 只移除故障 worker 的 lane membership
```

- 同 class 仍有 active member 时，其余 member 继续消费；不启用 fallback class。
- preferred active count 变为 0 时，控制面激活 fallback member set。
- Recoverable breaker open 后，先确认受影响 lane 仍有非目标 worker coverage，再执行 Auto Recovery hook。

单个 Recoverable 最多每 30 分钟自动执行一次 recovery；再次失败保持现有 coverage 并报警。

## 5. 恢复与 Class Handback

Recoverable 网络恢复后：

```text
observation window = 60s
health checks = 3
health interval = 10s
half-open concurrency = 1
```

三次检查全部成功，且 60 秒内没有新的 empty/network failure，才重新成为 eligible preferred member。公网 IP 是否变化只做观测；最终以健康验证为准。

preferred member 获得 membership 并开始消费后，fallback member 立即 pause 该 lane 的新 claim，只保留短暂 draining 状态来完成或安全重排已经领取的 job。控制面随后释放 fallback membership。

## 6. Auto Recovery Hook 解耦

Failover 核心只提供：

```text
drain target member → verify lane coverage → hook gate
→ MaintenanceHook → verify target → restore membership
```

Recoverable 通过 `autoRecoveryHookKind` 选择 adapter。Router reboot 项目实现其中一种 `MaintenanceHook`；其他换 IP 或网络恢复 workflow 使用同一 contract。Hook 不直接操作 BullMQ、lane membership 或其他 worker，也不包含在本规格中的设备 API 细节。

## 7. Graceful Upgrade

计划内升级只 drain 目标 member：

```text
pause target's new claims
→ verify remaining/fallback coverage
→ active jobs reach job-specific safe point
→ release target memberships
→ stop old process
→ start and verify new process
→ rejoin desired member sets
```

- Rival/Map 可在短 grace 后 abort/requeue。
- `scan_qr` 优先让当前 attempt 在有效期内完成。
- `add_rival` 请求发出后必须得到明确结果或标记 outcome unknown。
- `get_music_score` 必须完成 cleanup，或确认 durable cleanup 可由新进程接管。
- Worker 返回 `blocked` 时部署延后，禁止强杀用户 job。

同一 lane 的其他 active member 在整个升级过程中继续消费。

## 8. 数据库与 API 摘要

MongoDB：

```text
modify sdgb_jobs
add    sdgb_maintenance_runs
```

Redis 保存 heartbeat、worker health/breaker、desired member set、每 worker 的 lane membership lease、desired drain 和 maintenance 热状态。

内部 API 扩展 heartbeat 和 job PATCH；新增 worker incident、maintenance create/get、hook observation。详细字段见 [数据库与内部 API](./05-database-and-apis.md)。

## 9. 关键不变量

1. 只有控制面选中的 desired member 可以领取对应 lane 的新 job。
2. Probe 优先 Recoverable；Interactive 优先 Stable。preferred active count 大于 0 时 fallback 不领取新 job。
3. 单个 member 故障只移除该 member；同 class 尚有 active member 时不跨 class failover。
4. Breaker open 后故障 worker 不发起新的普通外部请求。
5. Probe failover 到 Stable 后不提高任何 Stable worker 的 global 上限，也不影响 Interactive 本地优先级。
6. Retry 使用原 job ID；旧 execution token/membership epoch 不能覆盖新执行结果。
7. Auto Recovery hook 只在目标 worker 已停止领取 job、受影响 lane 有非目标 coverage 后执行。
8. 一个公网 IP 只允许一个 worker 进程发起外部请求；QPS 与并发策略按 worker/public IP 独立生效。
9. 计划内升级不依赖 BullMQ stalled recovery 处理 active 用户 job。
10. Hook、日志、heartbeat 和数据库不保存外部调用细节或敏感正文。

## 10. 验收摘要

- 同一 lane 配置两个 active member 时，BullMQ job 在二者间实际分流，单个 job 不会重复执行。
- 一个 preferred member 故障时其余 preferred member 持续服务，fallback class 保持 inactive。
- 全部 preferred member 故障时 fallback member set 接管；preferred 恢复后 fallback 安全 drain。
- Router hook 只影响目标 Recoverable，其他 member 和 Interactive 保持可用。
- Stable 接管 Probe 时，Interactive limiter wait 增量符合目标。
- Graceful upgrade 不中断剩余 member，不产生 active 用户 job 的普通失败。
- Membership TTL/fencing 拒绝未授权 member 和旧进程写回。
- 所有自动化测试使用 fake UpstreamAdapter，不访问真实外部服务。
