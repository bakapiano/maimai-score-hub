# 空响应、Circuit Breaker 与任务重投

[← 返回总览](./README.md)

## 1. 问题

空响应可能表示出口被频控、边缘策略、上游异常或连接问题。无论真实原因是什么，worker 都不能在短时间内持续重试并放大故障。

本文只定义抽象响应分类，不记录上游地址、协议、请求正文或响应正文。

## 2. 错误分类

```ts
type UpstreamFailureClass =
  | "empty_response"
  | "network_error"
  | "timeout"
  | "http_rejected"
  | "invalid_response"
  | "outcome_unknown"
  | "canceled"
  | "lease_lost";
```

稳定内部 errorCode：

```text
UPSTREAM_EMPTY_RESPONSE
UPSTREAM_IP_BLOCKED
UPSTREAM_NETWORK_ERROR
UPSTREAM_TIMEOUT
UPSTREAM_INVALID_RESPONSE
UPSTREAM_OUTCOME_UNKNOWN
JOB_CANCELED
LANE_LEASE_LOST
```

业务上“列表为空”不是 transport empty response。只有响应体实际缺失且业务契约要求非空时才计入 `empty_response`。

## 3. Circuit Breaker 维度

在“一公网出口一 worker”的约束下，Breaker 直接按 worker + networkEpoch 维护：

```text
sdgb:workers:<workerId>:breaker
```

Breaker 记录触发时的 publicIp/networkEpoch。公网 IP 变化后状态回到 `unknown/half_open`，必须健康验证，不能仅因为 IP 字符串变化直接 close。

可选增加 lane/API class 子维度用于诊断，但不能让子 breaker 绕过 worker 总 breaker。

## 4. 状态机

```text
closed
  -> threshold reached
  -> open
  -> cooldown elapsed or explicit verify
  -> half_open
  -> consecutive probe successes
  -> closed

half_open failure -> open
```

建议初始参数：

```text
consecutive empty threshold = 3
observation window          = 10s
open cooldown               = 60s
half-open max in-flight     = 1
close successes             = 2
max automatic cooldown      = 15min
```

参数必须可配置，并通过观测收敛。不能把推测的外部阈值硬编码进业务逻辑。

## 5. Open 动作

Breaker open 时原子执行或最终一致完成：

1. 将 worker upstream health 标记为 blocked。
2. 拒绝该 worker 的新普通上游 token。
3. 对当前 worker 的受影响 lane 执行本地 pause。
4. 如果是 exclusive owner，进入 drain 并释放 lane lease。
5. 触发 standby selection。
6. 对 active job 按 job 语义 cancel/requeue/cleanup。
7. 记录 breaker event 和报警。

不能在 open 后继续完成普通重试预算。Cleanup 可以使用保留预算，但仍需限流和审计。

## 6. Retry 数据模型

建议在 job 文档增加：

```ts
type RetryMetadata = {
  lane: SdgbLane;
  routingVersion: number;
  attempt: number;
  maxAttempts: number;
  retryAt: Date | null;
  retryReason: string | null;
  failureClass: UpstreamFailureClass | null;
  lastWorkerId: string | null;
  lastLeaseEpoch: number | null;
  outcomeUnknown: boolean;
};
```

核心 status 建议保持：

```text
queued | processing | completed | failed | canceled
```

等待重试时使用 `status=queued + retryAt`，BullMQ job 进入 delayed；不新增与 BullMQ 状态重复的 `retry_wait` status。

## 7. BullMQ 重投

当前 worker 在业务异常后直接把 Mongo job 标记 failed 并正常结束 BullMQ processor，这种路径无法重投。目标路径：

```text
retryable failure
→ PATCH/atomic update status=queued, retry metadata
→ processor 抛出 RetryableJobError
→ BullMQ 按 backoff 移到 delayed
→ 下一 worker 使用相同 jobId 重试
```

要求：

- BullMQ `attempts` 与 Mongo `maxAttempts` 一致；
- QueueEvents 只在最终耗尽时把 Mongo 标记 failed；
- 同一 attempt 通过 execution token 防止重复 terminal patch；
- Retry 不创建新的 Mongo job ID；
- RetryAt 使用带 jitter 的有界指数退避；
- Failover 场景可缩短第一次 retryAt，但必须等 standby active。

## 8. Job 类型策略

| Job type          | 空响应处理                       | 自动重投                                                                                  |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `get_rival_hash`  | read-only，计入 breaker。        | 安全；可在 standby active 后立即重投，保留总 attempt 上限。                               |
| `get_user_map`    | read-only，计入 breaker。        | 安全；与 Rival 相同。                                                                     |
| `scan_qr`         | 输入有有效期，优先保护用户时延。 | 仅短重试；超过 deadline 失败并提示重新提交。                                              |
| `add_rival`       | 可能已经产生副作用。             | 请求发出后空响应视为 `outcome_unknown`，禁止盲目自动重投；先查询/对账或依赖明确幂等语义。 |
| `get_music_score` | 根据当前 session phase 分类。    | 建立会话前可短重试；建立后必须先完成 cleanup，不能直接在另一 worker 重跑业务步骤。        |

## 9. Retry Budget

Retry budget 同时受以下限制：

- job `maxAttempts`；
- 业务 deadline；
- 输入有效期；
- breaker state；
- lane ownership；
- worker upstream health；
- cancellation；
- 会话 cleanup 状态。

建议初始策略：

| 类别                  |   max attempts | backoff                                     |
| --------------------- | -------------: | ------------------------------------------- |
| Probe read-only       |              3 | failover-ready 后 1s、带 jitter 的 5s/15s   |
| Interactive ephemeral |              2 | 1s，且不得超过业务 deadline                 |
| Side-effecting        |    1 automatic | outcome reconciliation 后才能产生新 attempt |
| Session business flow | phase-specific | cleanup 优先，不使用通用 retry 覆盖         |

## 10. Half-open Health Verification

Half-open 使用独立的 `UpstreamHealthCheck` 抽象：

```ts
type HealthResult = {
  ok: boolean;
  responseClass: "valid" | "empty" | "network" | "invalid";
  latencyMs: number;
  checkedAt: string;
};
```

Health check：

- 不从用户 job 复制敏感 payload；
- 使用固定、只读、低成本的内部检查策略；
- 不输出原始响应；
- 受该 worker 的 global limiter；
- half-open 同一 worker 最多一个并发；
- 结果进入 breaker event，不创建业务 job。

具体上游调用实现属于 adapter，不写入本 spec。

## 11. 防止重试风暴

- Breaker open 后禁止每个 job 自己独立探测恢复。
- 仅由 worker health coordinator 执行 half-open probe。
- Delayed jobs 等待 breaker closed/standby active 后再释放。
- Worker 启动时不能一次性把所有 overdue retry 变为 waiting；按 jitter 和 global budget 渐进释放。
- Queue repair 不得绕过 retryAt。
- 多 Backend 副本通过原子 command/lease 保证只有一个 release coordinator。

## 12. 指标与事件

```text
sdgb_upstream_failure_total{workerId,lane,jobType,failureClass}
sdgb_empty_response_consecutive{workerId}
sdgb_breaker_state{workerId,state}
sdgb_breaker_transition_total{workerId,from,to,reason}
sdgb_job_retry_total{lane,jobType,reason}
sdgb_job_retry_delay_seconds{lane,jobType}
sdgb_outcome_unknown_total{jobType}
```

结构化事件保存 request/job ID、worker、publicIp/networkEpoch、lane、attempt、状态分类和耗时；禁止保存上游地址、敏感请求头、payload 或原始响应。
