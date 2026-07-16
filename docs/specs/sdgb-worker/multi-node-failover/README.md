# sdgb-worker 双类型 Worker、Failover 与 Auto Recovery

状态：Proposed

日期：2026-07-16

本文是可直接进入实现的 sdgb-worker 多节点 Failover 规格。范围固定为两类 worker、两条单-active lane、空响应接管、路由 Auto Recovery hook、Probe 重投、Stable 用户请求 QoS 和 graceful upgrade。

所有外部调用统一由 `UpstreamAdapter` 抽象。文档不包含外部地址、请求格式、凭据、密钥、加密方式或原始响应。

## 文档导航

- [架构与 Worker/Lane 决策](./01-architecture.md)
- [Worker Registry、Lane Lease 与限流](./02-registry-lane-rate-limit.md)
- [Failover 与 Router Hook 状态机](./03-failover-router-hook.md)
- [Empty Response、重投与 Graceful Shutdown](./04-empty-retry-graceful-shutdown.md)
- [数据库与内部 API](./05-database-and-apis.md)
- [测试与上线](./06-testing-rollout.md)

## 1. 两类 Worker

| workerClass   | 主要职责                     | Auto Recovery                            | 请求策略                                    | 可接受性                     |
| ------------- | ---------------------------- | ---------------------------------------- | ------------------------------------------- | ---------------------------- |
| `recoverable` | Probe 主力                   | 必须配置；故障后执行独立 MaintenanceHook | 不设置软件 QPS 上限；使用有限并发和 breaker | 可接受恢复期间部分 downtime  |
| `stable`      | Interactive 主力、Probe 备用 | 不执行自动网络恢复                       | 严格 global + job-type 分层限流             | 优先保证用户任务稳定和低延迟 |

首版每个公网 IP 只运行一个 sdgb-worker 进程。Worker 升级采用 graceful drain-stop-start，不允许同 IP 双进程同时发起外部请求。

## 2. 两条 Lane

| Lane          | Job types                                 | Worker 选择顺序          |
| ------------- | ----------------------------------------- | ------------------------ |
| `probe`       | `get_rival_hash`, `get_user_map`          | `recoverable` → `stable` |
| `interactive` | `scan_qr`, `add_rival`, `get_music_score` | `stable` → `recoverable` |

两条 lane 均为单 active。只有 lane lease owner 可以消费对应 BullMQ queue。首选 class 没有 healthy/active 候选时，控制面才能跨 class failover。

## 3. 已确认首版参数

### 3.1 Recoverable

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

Recoverable 不限 QPS，但不允许无限并发、无限重试或 breaker open 后继续请求。

### 3.2 Stable

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

Interactive 无 waiter 时 Probe 可以借用空闲 token；Interactive 到达后必须获得下一个 root token。Probe backlog 不得排在 Interactive waiter 前，也不得占满连接或 semaphore。

在 `global=1.5 QPS / burst=1` 且 Interactive 自身未超容量时，Probe backlog 给新 Interactive 请求增加的 limiter wait 目标上界约为一个 token interval（约 667ms）加调度误差。

## 4. Empty Response 决策

```text
10 秒内连续 3 次 transport empty
→ breaker open
→ worker 本地 fail closed
→ durable incident + heartbeat blocked/draining
→ Rival/Map 使用同 jobId 重排
→ 控制面切换 Probe owner
```

Recoverable breaker open 后，先确认备用 worker 已接管，再执行 Auto Recovery hook。单个 Recoverable 最多每 30 分钟自动执行一次 recovery；再次失败保持备用 owner 并报警。

## 5. 恢复与 Handback

Recoverable 网络恢复后：

```text
observation window = 60s
health checks = 3
health interval = 10s
half-open concurrency = 1
```

三次检查全部成功，且 60 秒内没有新的 empty/network failure，才允许 Probe handback。公网 IP 是否变化只做观测；最终以健康验证为准。

## 6. Router Auto Recovery 解耦

Failover 核心只提供：

```text
drain → standby active → hook gate → verify → handback
```

现有 router reboot 项目只实现 `MaintenanceHook`：等待 `hookMayRun=true` 后执行重启，网络恢复后主动提交非敏感 observation。Hook 不直接操作 BullMQ、lane owner 或备用 worker。

## 7. Graceful Upgrade

计划内升级必须：

```text
pause new claims
→ active jobs reach job-specific safe point
→ optional lane handoff
→ stop old process
→ start and verify new process
→ reacquire/handback lane
```

- Rival/Map 可在短 grace 后 abort/requeue。
- `scan_qr` 优先让当前 attempt 在有效期内完成。
- `add_rival` 请求发出后必须得到明确结果或标记 outcome unknown。
- `get_music_score` 必须完成 cleanup，或确认 durable cleanup 可由新进程接管。
- Worker 返回 `blocked` 时部署延后，禁止强杀用户 job。

## 8. 数据库与 API 摘要

MongoDB：

```text
modify sdgb_jobs
add    sdgb_maintenance_runs
```

Redis：heartbeat、worker health/breaker、lane owner/epoch、desired drain 和 maintenance 热状态。

内部 API：扩展 heartbeat 和 job PATCH；新增 worker incident、maintenance create/get、hook observation。详细字段见 [数据库与内部 API](./05-database-and-apis.md)。

## 9. 关键不变量

1. 每条 lane 任意时刻最多一个有效 owner。
2. Probe 优先 Recoverable；Interactive 优先 Stable。
3. Breaker open 后不发起新的普通外部请求。
4. Probe failover 到 Stable 后不提高 Stable global 上限，也不影响 Interactive 保留容量。
5. Retry 使用原 job ID；旧 execution token 不能覆盖新 owner 的结果。
6. Auto Recovery hook 只在 standby active 后执行。
7. 一个公网 IP 只允许一个 worker 进程发起外部请求。
8. 计划内升级不依赖 BullMQ stalled recovery 处理 active 用户 job。
9. Hook、日志、heartbeat 和数据库不保存外部调用细节或敏感正文。

## 10. 验收摘要

- Recoverable 空响应后，Stable 接管 Probe，Interactive limiter wait 增量符合目标。
- Router hook 执行期间 Interactive 保持可用，Probe job 不丢失。
- Recoverable 通过健康 gate 后安全 handback。
- Stable 失败时，Interactive 可 failover 到 Recoverable 并明确显示降级状态。
- Graceful upgrade 不产生 active 用户 job 的普通失败。
- Redis lease/fencing 防止双 owner 和旧进程写回。
- 所有自动化测试使用 fake UpstreamAdapter，不访问真实外部服务。
