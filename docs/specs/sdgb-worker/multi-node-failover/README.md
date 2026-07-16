# sdgb-worker 多节点、Failover 与任务恢复

状态：Proposed

日期：2026-07-16

本文定义 sdgb-worker 从固定双机部署演进为可扩展多节点执行平台的目标设计。设计覆盖 worker 能力注册、逻辑 lane、出口网络分组、单 owner 与多 active 策略、计划内维护切换、非计划故障接管、空响应熔断、任务重投、主动取消、分布式限流和分阶段发布。

本文只描述 Score Hub 内部调度与控制面。所有外部系统均统一称为“上游”，调用由 `UpstreamAdapter` 抽象；本文不记录上游地址、请求格式、凭据、密钥、加密方式或响应正文。

## 文档导航

- [总体架构与扩展模型](./01-architecture.md)
- [Worker Registry、Lane Ownership 与分布式限流](./02-registry-ownership-rate-limit.md)
- [计划内与非计划 Failover 状态机](./03-failover-state-machine.md)
- [空响应、Circuit Breaker 与任务重投](./04-empty-response-retry.md)
- [主动取消与各 Job 语义](./05-cancellation-job-semantics.md)
- [控制面与数据契约](./06-control-plane-contracts.md)
- [测试、发布与运维](./07-testing-rollout-operations.md)

## 1. 决策摘要

- 保留逻辑 lane，不按机器创建队列。初始 lane 为 `probe` 和 `interactive`，未来可增加 `session` 或 Probe shard。
- Worker 不再由单一 `role` 决定全部行为，而是分别声明 `capabilities` 和运行时 `activeLanes`。
- `probe` 初始采用单 active、多 standby；只有持有 Redis owner lease 的 worker 可以消费 Probe queue。
- `interactive` 初始仍为单 active，但数据结构和限流支持未来多 active。
- Worker 使用稳定的 `egressGroup` 表示共享公网出口的实例集合；动态公网 IP 是该分组的观测属性，不是分组 ID。
- 上游请求配额按 `egressGroup` 使用 Redis 原子 token bucket 统一计算，避免同一 NAT 下多进程分别限流导致总量翻倍。
- 计划内维护使用 drain → standby takeover → maintenance → health verification → handback 状态机。
- 连续空响应触发按出口维度的 circuit breaker；Probe owner 暂停领取、释放 lease，并由健康 standby 接管。
- 只读 Probe job 可以安全中止和重投；有副作用或会话状态的 job 必须遵循各自的模糊结果与 cleanup 规则。
- BullMQ pause/remove 不能代替 active job 取消；active job 必须通过 `AbortController` 和 job phase 执行协作式终止。
- Backend 多副本共同提供控制面，但所有 ownership、drain 和命令状态转换必须通过 Redis 原子操作完成，不依赖单个 Backend 实例内存。
- Failover 核心不依赖路由器实现。路由器重启只是一个 `MaintenanceHook`；主机重启、网络切换、部署维护和人工操作复用同一 handoff 状态机。

## 2. 目标

- 新增 worker 时只需部署同一镜像并配置能力、出口分组和优先级，不修改业务生产者。
- 计划内网络维护期间，Probe queue 可以由 standby 接管，Interactive 用户任务不受影响。
- Worker 或出口异常时，在有健康 standby 的情况下自动恢复消费，且不产生双 owner。
- 空响应不形成无延迟重试风暴；安全 job 在 failover 后继续使用原 job ID 完成。
- 所有上游调用都受出口级总限流约束，多实例不会突破配置上限。
- 支持安全 drain、主动取消、升级、扩容、缩容和故障演练。
- Registry、lease、breaker、重试和取消状态可在 Admin/metrics 中审计。

## 3. 非目标

- 本文不定义任何上游协议、地址、请求或加密实现。
- 第一阶段不通过增加公网 IP 来提高吞吐；多节点首先用于可用性和维护切换。
- 第一阶段不同时运行多个 Probe owner，也不做自动 Probe 分片。
- 不保证通用分布式 exactly-once；目标是单 lane owner、幂等 enqueue、可审计重试和按 job 语义控制副作用。
- 不允许 worker 在 Redis 不可用或 ownership 不明确时继续发起新的上游请求。
- 不让路由维护程序直接选择固定备用机器；备用选择由控制面完成。
- 不把设备登录、重启或网络恢复实现放进 sdgb-worker/Backend；这些细节属于外部 hook adapter。

## 4. 术语

| 术语            | 含义                                                                  |
| --------------- | --------------------------------------------------------------------- |
| capability      | Worker 有能力安全执行的 job/lane 集合。                               |
| active lane     | Worker 当前实际消费的 lane。Capability 不代表当前 active。            |
| lane            | 具有相同 SLO、部署和 failover 策略的一组 job，对应稳定 BullMQ queue。 |
| egressGroup     | 共享同一公网出口、NAT、代理或 VPN 的 worker 集合。                    |
| lane owner      | 当前获准消费某个 exclusive lane 的 worker。                           |
| owner lease     | Redis 中带 TTL、随机 token 和 fencing epoch 的 lane ownership。       |
| drain           | 停止领取新 job，同时等待或协作终止 active job。                       |
| fencing token   | 单调递增的 ownership 世代，用于阻止失去 lease 的旧 worker 继续执行。  |
| circuit breaker | 根据出口异常在 closed/open/half-open 间切换的状态机。                 |
| outcome unknown | 请求可能已经产生副作用，但调用方未获得可确认结果。                    |

## 5. 初始 Lane 映射

| Job type          | Lane          | 初始策略                                   |
| ----------------- | ------------- | ------------------------------------------ |
| `get_rival_hash`  | `probe`       | 单 active，可中止、可重投。                |
| `get_user_map`    | `probe`       | 单 active，可中止、可重投。                |
| `scan_qr`         | `interactive` | 低延迟、有输入有效期，短重试。             |
| `add_rival`       | `interactive` | 可能产生副作用，避免盲目重投。             |
| `get_music_score` | `interactive` | 会话型 job，取消或迁移前必须完成 cleanup。 |

## 6. 关键不变量

1. Exclusive lane 在任意时刻最多一个有效 owner。
2. Worker 只有同时满足 capability、active assignment、有效 lease 和健康限流器时才可发起上游调用。
3. Lane lease 丢失后不得领取新 job；active job 在下一 fencing checkpoint 停止或进入安全 cleanup。
4. 同一 `egressGroup` 的所有进程共享同一个上游请求预算。
5. Job lane 在 enqueue 时写入 job 文档，后续路由表调整不能静默移动已创建 job。
6. Retry 使用原 job ID，并带 attempt、reason、retryAt 和上一执行 worker 信息。
7. 有副作用的 job 在结果不明确时进入 `outcomeUnknown`，不能伪装成安全失败或自动无限重试。
8. 会话型 job 的 cleanup 优先级高于 failover、cancel 和新业务读取。
9. 控制命令必须有 `requestId` 并幂等；重复请求不得重复切换或重复取消。
10. 日志、heartbeat 和指标不包含上游凭据、敏感 payload 或原始响应。

## 7. 验收摘要

- 计划内 handoff 期间无 job 丢失、无双 owner，Interactive SLO 不下降。
- Primary 进程或网络突然消失后，standby 在目标时间内接管 Probe lane。
- 连续空响应后，原 worker 停止新增上游流量，安全 Probe job 在备用出口完成。
- Redis 故障时所有 exclusive lane fail closed。
- 新增第三、第四台 worker 不需要新增队列或修改 job producer。
- 全部自动化测试使用 fake upstream adapter，不依赖真实外部服务。
