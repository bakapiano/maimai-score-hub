# Empty Response、重投与 Graceful Shutdown

[← 返回总览](./README.md)

## 1. 错误分类

```ts
type FailureClass =
  | "empty_response"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "outcome_unknown"
  | "lease_lost";
```

业务列表为空不等于 transport empty。本文不保存原始请求或响应。

## 2. Circuit Breaker

Breaker 按 worker + networkEpoch 保存：

```text
closed
→ 10s 内连续 3 次 empty
→ open
→ Auto Recovery / cooldown
→ half_open（单并发）
→ 3 次成功
→ closed
```

任一正常有效响应清除连续 empty counter。Half-open 失败重新 open，cooldown 为 1/2/5/10/15 分钟。

## 3. WorkerIncident

Breaker open 时 worker 发送 durable incident：

```ts
type WorkerIncident = {
  incidentId: string;
  workerId: string;
  workerClass: "recoverable" | "stable";
  publicIp?: string;
  networkEpoch: number;
  activeLanes: Array<"probe" | "interactive">;
  failureClass: "empty_response";
  consecutiveCount: 3;
  observationWindowMs: 10000;
  activeJobsByType: Partial<Record<SdgbJobType, number>>;
  occurredAt: string;
};
```

Incident 以 incidentId 幂等，不含 payload 或原始响应。

Heartbeat 同时更新：

```json
{
  "upstreamHealth": "blocked",
  "breakerState": "open",
  "drainingLanes": ["probe"],
  "autoRecoveryState": "requested"
}
```

Stable 不设置 Auto Recovery requested，只报告 blocked/open/draining。

## 4. Recoverable Empty 时序

```text
第 1/2 次 empty
→ 记录 UPSTREAM_EMPTY_RESPONSE
→ 当前 Rival/Map 保持 retryable

第 3 次 empty
→ breaker open
→ durable WorkerIncident
→ close local request gate
→ pause Probe consumer
→ abort/requeue active Rival/Map

Control Plane
→ 选择其他 Recoverable；没有则选择 Stable
→ transfer Probe lease

Stable
→ resume Probe
→ release delayed retries with jitter
→ Interactive 优先，Probe 使用剩余 token

Standby active 后
→ create maintenance run
→ hookMayRun
→ Auto Recovery hook

Recoverable 恢复
→ 60s clean window + 3 checks/10s
→ handback
```

## 5. Probe 重投

Rival/Map 使用同一 Mongo job ID：

```text
retryable failure
→ guarded update status=queued
→ attempt += 1
→ retryAt/retryReason/failureClass
→ BullMQ delayed
→ 新 owner 使用相同 jobId claim
```

默认：

```text
maxAttempts = 3
backoff = 1s, jittered 5s, jittered 15s
```

Failover 已确认 standby active 后，可以提前释放第一次 delayed retry，但必须带 jitter。Queue repair 尊重 retryAt。

QueueEvents 只在 attempts 最终耗尽时写 failed。Worker 不能先把 Mongo job terminal failed 再期待 BullMQ retry。

## 6. Execution Fence

Claim 写入：

```ts
executionToken: string;
executionWorkerId: string;
executionLeaseEpoch: number;
executionNetworkEpoch: number;
```

Requeue/terminal patch 必须匹配 executionToken。旧 worker 在 failover 后恢复，不能覆盖新 owner 结果。

## 7. Active Job Registry

Worker 内存维护：

```ts
type ActiveJobContext = {
  jobId: string;
  jobType: SdgbJobType;
  lane: "probe" | "interactive";
  phase: string;
  controller: AbortController;
  requestStarted: boolean;
  sideEffectPossible: boolean;
};
```

AbortSignal 从 BullMQ processor 传到 request scheduler 和 UpstreamAdapter。Semaphore、token wait、backoff 和请求本身都可取消。

## 8. Job-specific Drain

| Job type          | Drain/empty 行为                                                                 |
| ----------------- | -------------------------------------------------------------------------------- |
| `get_rival_hash`  | Read-only；短 grace 后 abort，同 jobId requeue。                                 |
| `get_user_map`    | Read-only；与 Rival 相同。                                                       |
| `scan_qr`         | 优先让当前 attempt 在输入有效期内完成；未开始可留在 queue。                      |
| `add_rival`       | 请求未发出可停止；发出后等待明确结果，无法确认则 `outcome_unknown`，不盲目重投。 |
| `get_music_score` | 建立 session 前可停止；建立后必须完成 cleanup，或确认 durable cleanup 可接管。   |

本实现不增加通用用户 cancel API。主动 abort 仅用于 Probe failover、worker drain 和进程 shutdown。

## 9. Graceful Shutdown

SIGTERM、deployment drain 和 maintenance drain 共用一个 coordinator：

```text
pause local consumers
→ mark draining
→ finish or requeue Probe
→ finish side-effect disposition
→ finish/persist session cleanup
→ close BullMQ/Redis/HTTP/log shipper
→ exit
```

Shutdown 返回：

```text
drained
cleanup_handoff_ready
blocked
```

- `drained`：active job 已结束或安全重排。
- `cleanup_handoff_ready`：剩余 session 已有 durable recovery 保护。
- `blocked`：仍有不能安全停止的 job；计划内升级必须延后。

计划内升级不走 force kill。只有进程失控的系统级 deadline 才允许强制退出，且必须保留 cleanup/recovery 状态。

## 10. Stable Failover QoS

Stable 接管 Probe 时：

- Probe concurrency cap=4。
- Probe waiting request 不进入 Interactive 前面的 FIFO。
- Interactive 获得下一个 root token。
- Interactive 无 waiter 时 Probe 借用空闲容量。
- Stable global 仍为 1.5 QPS，不因 failover 提高。

测试必须先排入大量 Probe waiter，再插入 Interactive，断言 Interactive limiter wait 不超过 `1/globalQps + scheduler tolerance`。

## 11. 指标

```text
sdgb_empty_response_consecutive{workerId}
sdgb_breaker_state{workerId,state}
sdgb_worker_incident_total{workerId,kind}
sdgb_job_retry_total{jobType,reason}
sdgb_probe_requeue_total{fromWorker,toWorker}
sdgb_shutdown_state{workerId,state}
sdgb_outcome_unknown_total{jobType}
```

Public IP 不作为 metrics label，仅进入安全的状态详情与 incident attrs。
