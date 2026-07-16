# sdgb-worker 多节点、Failover 与任务恢复

状态：Proposed

日期：2026-07-16

本文定义 sdgb-worker 从固定双机部署演进为可扩展多节点执行平台的目标设计。设计覆盖 worker 能力注册、逻辑 lane、单 owner 与多 active 策略、计划内维护切换、非计划故障接管、空响应熔断、任务重投、主动取消、限流和分阶段发布。

本文只描述 Score Hub 内部调度与控制面。所有外部系统均统一称为“上游”，调用由 `UpstreamAdapter` 抽象；本文不记录上游地址、请求格式、凭据、密钥、加密方式或响应正文。

## 文档导航

- [总体架构与扩展模型](./01-architecture.md)
- [Worker Registry、Lane Ownership 与限流](./02-registry-ownership-rate-limit.md)
- [计划内与非计划 Failover 状态机](./03-failover-state-machine.md)
- [空响应、Circuit Breaker 与任务重投](./04-empty-response-retry.md)
- [主动取消与各 Job 语义](./05-cancellation-job-semantics.md)
- [控制面与数据契约](./06-control-plane-contracts.md)
- [测试、发布与运维](./07-testing-rollout-operations.md)
- [数据库与内部 API](./08-database-and-apis.md)

## 1. 核心决策：两类 Worker

Worker 固定分为两类：

| workerClass   | 定位                      | Auto Recovery                                      | QPS 策略                                            | 可接受性                         |
| ------------- | ------------------------- | -------------------------------------------------- | --------------------------------------------------- | -------------------------------- |
| `recoverable` | 高吞吐 Probe 主力         | 必须配置；故障后通过 MaintenanceHook 恢复网络/出口 | 不设置软件 QPS 上限；保留有限并发和 circuit breaker | 可接受恢复期间部分 downtime      |
| `stable`      | 用户请求主力与 Probe 备用 | 不依赖自动恢复                                     | 严格 global + job-type 分层限流                     | 优先保证用户相关任务稳定与低延迟 |

Lane 的 workerClass 优先级固定为：

| Lane          | 第一选择      | Failover 选择                                   |
| ------------- | ------------- | ----------------------------------------------- |
| `probe`       | `recoverable` | 没有 active/healthy recoverable 时使用 `stable` |
| `interactive` | `stable`      | 没有 active/healthy stable 时使用 `recoverable` |

`recoverable` 不做软件 QPS 节流，但“无限 QPS”不等于无限并发或无限重试：仍使用有限 semaphore、空响应 circuit breaker 和 failover。Breaker open 后先把 lane 交给其他 worker，再调用已配置的 Auto Recovery hook。

`stable` 在同时承接 Interactive 与 Probe failover 时，必须使用分层请求调度：

```text
cleanup
> interactive user jobs（保留容量，按 job type 限流）
> failover probe（仅使用剩余容量）
```

Probe backlog 不得占用为 Interactive 保留的 token，也不得让 Interactive waiter 排在 Probe 后面。

这里的“保留容量”不是静态切走一段闲置 QPS：Interactive 无 waiter 时 Probe 可以借用全部空闲 token；Interactive 一旦进入等待队列，下一个可用 root token 必须优先分配给 Interactive。调度器必须维护独立优先级 wait queue，禁止把所有 Probe waiter 预先放进单 FIFO token bucket。

## 2. 其他决策摘要

- 保留逻辑 lane，不按机器创建队列。初始 lane 为 `probe` 和 `interactive`，未来可增加 `session` 或 Probe shard。
- Worker 不再由单一 `role` 决定全部行为，而是分别声明 `capabilities` 和运行时 `activeLanes`。
- Worker 额外声明稳定的 `workerClass=recoverable|stable`；class 与 capability 相互独立。
- `probe` 初始采用单 active、多 standby；只有持有 Redis owner lease 的 worker 可以消费 Probe queue。
- `interactive` 初始仍为单 active，但数据结构和限流支持未来多 active。
- 明确约束一个公网出口只运行一个 sdgb-worker 进程；滚动升级使用 stop-start，不允许同 IP 双进程重叠。
- `stop-start` 必须是 graceful drain-stop-start：先停止领取并让 active job 达到安全终点，再停止进程；短暂停机不是跳过 graceful shutdown 的理由。
- `stable` worker 的所有 lane 使用同一个严格的进程级请求调度器；`recoverable` 不设置 QPS 上限。`publicIp` 只作为动态观测和 failover 验证字段。
- 计划内维护使用 drain → standby takeover → maintenance → health verification → handback 状态机。
- 连续空响应触发该 worker 的 circuit breaker；Probe owner 暂停领取、释放 lease，并由健康 standby 接管。
- 只读 Probe job 可以安全中止和重投；有副作用或会话状态的 job 必须遵循各自的模糊结果与 cleanup 规则。
- BullMQ pause/remove 不能代替 active job 取消；active job 必须通过 `AbortController` 和 job phase 执行协作式终止。
- Backend 多副本共同提供控制面，但所有 ownership、drain 和命令状态转换必须通过 Redis 原子操作完成，不依赖单个 Backend 实例内存。
- Failover 核心不依赖路由器实现。路由器重启只是一个 `MaintenanceHook`；主机重启、网络切换、部署维护和人工操作复用同一 handoff 状态机。

## 3. 目标

- 新增 worker 时只需部署同一镜像并配置 workerClass、能力和优先级，不修改业务生产者。
- 计划内网络维护期间，Probe queue 可以由 standby 接管，Interactive 用户任务不受影响。
- Worker 或其公网出口异常时，在有健康 standby 的情况下自动恢复消费，且不产生双 owner。
- 空响应不形成无延迟重试风暴；安全 job 在 failover 后继续使用原 job ID 完成。
- Stable worker 在 Probe failover 期间仍为 Interactive 保留请求容量和优先级。
- 支持安全 drain、主动取消、升级、扩容、缩容和故障演练。
- Registry、lease、breaker、重试和取消状态可在 Admin/metrics 中审计。

## 4. 非目标

- 本文不定义任何上游协议、地址、请求或加密实现。
- 第一阶段不通过增加公网 IP 来提高吞吐；多节点首先用于可用性和维护切换。
- 第一阶段不同时运行多个 Probe owner，也不做自动 Probe 分片。
- 不保证通用分布式 exactly-once；目标是单 lane owner、幂等 enqueue、可审计重试和按 job 语义控制副作用。
- 不允许 worker 在 Redis 不可用或 ownership 不明确时继续发起新的上游请求。
- 不让路由维护程序直接选择固定备用机器；备用选择由控制面完成。
- 不把设备登录、重启或网络恢复实现放进 sdgb-worker/Backend；这些细节属于外部 hook adapter。
- 第一阶段不为 recoverable worker 增加软件 QPS 限制；它的保护机制是有限并发、breaker、failover 和 Auto Recovery。

## 5. 术语

| 术语            | 含义                                                                  |
| --------------- | --------------------------------------------------------------------- |
| capability      | Worker 有能力安全执行的 job/lane 集合。                               |
| workerClass     | Worker 的恢复/限流类别：`recoverable` 或 `stable`。                   |
| active lane     | Worker 当前实际消费的 lane。Capability 不代表当前 active。            |
| lane            | 具有相同 SLO、部署和 failover 策略的一组 job，对应稳定 BullMQ queue。 |
| publicIp        | Worker 当前观测到的公网 IP；它会变化，只用于健康与 failover 验证。    |
| lane owner      | 当前获准消费某个 exclusive lane 的 worker。                           |
| owner lease     | Redis 中带 TTL、随机 token 和 fencing epoch 的 lane ownership。       |
| drain           | 停止领取新 job，同时等待或协作终止 active job。                       |
| fencing token   | 单调递增的 ownership 世代，用于阻止失去 lease 的旧 worker 继续执行。  |
| circuit breaker | 根据 worker 上游异常在 closed/open/half-open 间切换的状态机。         |
| outcome unknown | 请求可能已经产生副作用，但调用方未获得可确认结果。                    |

## 6. 初始 Lane 映射

| Job type          | Lane          | 初始策略                                   |
| ----------------- | ------------- | ------------------------------------------ |
| `get_rival_hash`  | `probe`       | 单 active，可中止、可重投。                |
| `get_user_map`    | `probe`       | 单 active，可中止、可重投。                |
| `scan_qr`         | `interactive` | 低延迟、有输入有效期，短重试。             |
| `add_rival`       | `interactive` | 可能产生副作用，避免盲目重投。             |
| `get_music_score` | `interactive` | 会话型 job，取消或迁移前必须完成 cleanup。 |

## 7. 关键不变量

1. Exclusive lane 在任意时刻最多一个有效 owner。
2. Worker 只有同时满足 capability、active assignment、有效 lease、breaker 和本 class 请求策略时才可发起上游调用。
3. Lane lease 丢失后不得领取新 job；active job 在下一 fencing checkpoint 停止或进入安全 cleanup。
4. 一个公网出口只允许一个 worker 进程；Stable 的所有 lane 共享严格 limiter，Recoverable 共享有限并发与 breaker。
5. Job lane 在 enqueue 时写入 job 文档，后续路由表调整不能静默移动已创建 job。
6. Retry 使用原 job ID，并带 attempt、reason、retryAt 和上一执行 worker 信息。
7. 有副作用的 job 在结果不明确时进入 `outcomeUnknown`，不能伪装成安全失败或自动无限重试。
8. 会话型 job 的 cleanup 优先级高于 failover、cancel 和新业务读取。
9. 控制命令必须有 `requestId` 并幂等；重复请求不得重复切换或重复取消。
10. 日志、heartbeat 和指标不包含上游凭据、敏感 payload 或原始响应。

11. Probe 分配优先 recoverable，Interactive 分配优先 stable；只有首选 class 无健康 active 候选时才跨 class failover。
12. Stable 上的 Probe failover 流量不能消耗 Interactive 保留容量。
13. 计划内升级不能依赖 BullMQ stalled recovery 处理 active 用户 job；必须执行 job-aware graceful drain 和 session cleanup。

## 8. 验收摘要

- 计划内 handoff 期间无 job 丢失、无双 owner，Interactive SLO 不下降。
- Primary 进程或网络突然消失后，standby 在目标时间内接管 Probe lane。
- 连续空响应后，原 worker 停止新增上游流量，安全 Probe job 在备用出口完成。
- Probe 正常由 Recoverable 承担；Recoverable 恢复期间由 Stable 接管并保护 Interactive 保留容量。
- Interactive 正常由 Stable 承担；只有无健康 Stable 时才降级到 Recoverable。
- Recoverable 的 Auto Recovery hook 只在 lane 已安全 handoff 后执行。
- Redis 故障时所有 exclusive lane fail closed。
- 新增第三、第四台 worker 不需要新增队列或修改 job producer。
- 全部自动化测试使用 fake upstream adapter，不依赖真实外部服务。
