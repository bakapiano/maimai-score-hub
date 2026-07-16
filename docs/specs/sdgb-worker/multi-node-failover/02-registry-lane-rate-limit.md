# Worker Registry、Lane Lease 与限流

[← 返回总览](./README.md)

## 1. Heartbeat

默认：

```text
heartbeat every = 10s
worker stale = 30s
registry TTL = 45s
```

Worker 上报：

```ts
type WorkerHeartbeat = {
  workerId: string;
  workerClass: "recoverable" | "stable";
  version: string;
  processGeneration: string;
  sequence: number;
  lifecycleState: "running" | "draining" | "cleanup_handoff_ready" | "blocked";
  capabilities: Array<"probe" | "interactive">;
  activeLanes: Array<"probe" | "interactive">;
  drainingLanes: Array<"probe" | "interactive">;
  publicIp?: string;
  networkEpoch: number;
  upstreamHealth: "unknown" | "healthy" | "degraded" | "blocked";
  breakerState: "closed" | "open" | "half_open";
  autoRecoveryState?: "idle" | "requested" | "running" | "verifying" | "failed";
  activeJobsByType: Partial<Record<SdgbJobType, number>>;
  shutdownBlockers?: Array<{
    jobId: string;
    jobType: SdgbJobType;
    phase: string;
  }>;
  jobsClaimedDelta: number;
};
```

Backend 在 heartbeat response 中返回 desired state：

```ts
type WorkerDesiredState = {
  desiredActiveLanes: Array<"probe" | "interactive">;
  drainLanes: Array<"probe" | "interactive">;
  maintenanceRequestId?: string;
  expectedLeaseEpochByLane: Partial<Record<SdgbLane, number>>;
};
```

Worker 每次 heartbeat 都 reconcile desired state，不需要独立 command stream。

## 2. Registry 校验

- workerId、workerClass、capabilities 必须存在且合法。
- workerClass 在 processGeneration 内不可变。
- active lane 必须属于 capability。
- Stable 缺少 strict rate policy 时拒绝 ready。
- Recoverable 缺少 Auto Recovery hook 配置时拒绝 ready。
- 两个 live worker 报告相同 publicIp 时标记部署冲突，均不自动获取新 lane。
- Sequence 对同一 processGeneration 单调递增。

Registry 只放 Redis TTL，不写 heartbeat collection。

## 3. Redis Keys

```text
sdgb:workers:<workerId>              heartbeat JSON, TTL
sdgb:workers:<workerId>:health       breaker/health state
sdgb:workers:<workerId>:drain        desired drain state
sdgb:workers:<workerId>:recovery     Recoverable hook state
sdgb:lanes:<lane>:owner              owner lease, TTL
sdgb:lanes:<lane>:epoch              monotonic epoch
sdgb:lanes:<lane>:desired-owner      handoff hint, TTL
sdgb:maintenance:<requestId>         hot maintenance view, TTL
```

## 4. Lane Lease

```ts
type LaneLease = {
  lane: "probe" | "interactive";
  workerId: string;
  token: string;
  epoch: number;
  processGeneration: string;
  workerNetworkEpoch: number;
  acquiredAt: string;
};
```

默认：

```text
TTL = 30s
renew every = 10s
```

Acquire 使用 Redis 原子脚本：

1. Key 不存在。
2. Worker heartbeat fresh、healthy、未 drain。
3. Capability 和 workerClass priority 合法。
4. 增加 epoch。
5. 写随机 token、workerId、processGeneration、networkEpoch 和 TTL。

Renew 比较 token + epoch + generation + networkEpoch。Release 使用 compare-and-delete，禁止直接 DEL。

## 5. Fencing

Active job 保存：

```ts
type ExecutionFence = {
  lane: SdgbLane;
  workerId: string;
  executionToken: string;
  leaseToken: string;
  leaseEpoch: number;
  processGeneration: string;
  networkEpoch: number;
};
```

检查点：

- 领取 BullMQ job 并读取 Mongo 后；
- 等待 request scheduler 后；
- 每次外部请求前；
- 写 requeue/terminal 前；
- session phase 转换前。

Fence 失效时 pause lane。Rival/Map abort/requeue；用户 job 按 graceful 规则完成或 cleanup。

## 6. Worker 选择

固定 class priority：

```text
probe:       recoverable -> stable
interactive: stable -> recoverable
```

候选过滤：

- heartbeat fresh；
- healthy、breaker closed；
- capability 匹配；
- lifecycle=running；
- 版本兼容；
- publicIp 已验证；
- 网络 failover 时与原 worker publicIp 不同。

同一 class 内排序：lane preference → active job 数 → heartbeat health time → workerId。

只有首选 class 无 eligible candidate 时才考虑第二 class。

## 7. Recoverable 请求策略

```text
worker total = 16
get_rival_hash = 8
get_user_map = 4
scan_qr = 1
add_rival = 1
get_music_score = 2
cleanup = 1 independent
QPS bucket = none
```

Recoverable 仍必须：

- 使用 semaphore 控制并发；
- 在 breaker open 后关闭请求 gate；
- 等待 failover 完成后才执行 Auto Recovery；
- 禁止无延迟无限 retry。

## 8. Stable 请求策略

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

Job-type 数值是 ceiling，root global 始终 authoritative。

Stable 使用三个独立 wait queue：

```text
cleanup > interactive > probe
```

Token 分配：

1. Cleanup 有 waiter：给 cleanup。
2. 否则 Interactive 有 waiter：给 Interactive。
3. 否则给 Probe。

Probe 可借用空闲容量，但不能预占未来 token。Interactive 到达后获得下一个 token。Probe concurrency cap 必须为 Interactive 保留连接和 semaphore slot。

## 9. Public IP / Network Epoch

Worker 发现 publicIp 变化：

1. `networkEpoch += 1`。
2. health 变为 unknown。
3. 现有 lane lease renew 因 networkEpoch 不匹配而失败。
4. 完成健康验证后重新 eligible。

Public IP 不进入时序指标 label，只进入 worker status 和 incident attrs。

## 10. Redis 故障

- Registry/lease Redis 不可用时不领取新 job。
- Lease renew 失败立即 pause exclusive lane。
- Stable 本地 limiter 或 Recoverable semaphore 继续约束正在收尾的安全步骤。
- Session job 只允许执行 cleanup。
- Redis 恢复后重新 heartbeat/acquire，不能沿用旧内存 lease。

## 11. 指标

```text
sdgb_worker_registry_age_seconds{workerId}
sdgb_worker_health{workerId,state}
sdgb_worker_breaker_state{workerId,state}
sdgb_worker_auto_recovery_state{workerId,state}
sdgb_lane_owner{lane,workerId}
sdgb_lane_lease_epoch{lane}
sdgb_lane_handoff_total{lane,result,reason}
sdgb_stable_rate_wait_seconds{workerId,trafficClass}
sdgb_fence_rejected_total{lane,jobType}
```
