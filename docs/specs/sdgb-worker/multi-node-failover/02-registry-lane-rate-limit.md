# Worker Registry、Lane Membership 与限流

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
type ReportedLaneMembership = {
  lane: "probe" | "interactive";
  state: "active" | "draining";
  membershipEpoch: number;
};

type WorkerHeartbeat = {
  workerId: string;
  workerClass: "recoverable" | "stable";
  autoRecoveryHookKind?: string;
  version: string;
  processGeneration: string;
  sequence: number;
  lifecycleState: "running" | "draining" | "cleanup_handoff_ready" | "blocked";
  capabilities: Array<"probe" | "interactive">;
  laneMemberships: ReportedLaneMembership[];
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

Backend 在 heartbeat response 中对 worker 有 capability 的 lane 返回完整 desired state：

```ts
type DesiredLaneMembership = {
  state: "active" | "draining" | "inactive";
  expectedMembershipEpoch?: number;
};

type WorkerDesiredState = {
  desiredLaneMemberships: Partial<
    Record<"probe" | "interactive", DesiredLaneMembership>
  >;
  maintenanceRequestId?: string;
};
```

`active` 表示应持有 membership 并消费；`draining` 表示立即停止新 claim、处理已有 job 后释放；`inactive` 表示不得持有 membership。Worker 每次 heartbeat 都 reconcile，不需要独立 command stream。

## 2. Registry 校验

- workerId、workerClass、capabilities 必须存在且合法。
- workerClass 在 processGeneration 内不可变。
- Reported membership 必须属于 capability，且 epoch 与 Redis membership 一致。
- Stable 缺少 strict rate policy 或错误配置 Auto Recovery hook 时拒绝 ready。
- Recoverable 缺少 autoRecoveryHookKind，或该 kind 没有已注册 adapter 时拒绝 ready。
- 两个 live worker 报告相同 publicIp 时标记部署冲突，均不加入新的 desired set。
- Sequence 对同一 processGeneration 单调递增。

Registry 只放 Redis TTL，不写 heartbeat collection。

## 3. Redis Keys

```text
sdgb:workers:<workerId>                         heartbeat JSON, TTL
sdgb:workers:<workerId>:health                  breaker/health state
sdgb:workers:<workerId>:drain                   desired drain state
sdgb:workers:<workerId>:recovery                Recoverable hook state
sdgb:lanes:<lane>:desired-members               desired workerId/state/epoch set, TTL
sdgb:lanes:<lane>:members:<workerId>            per-worker membership lease, TTL
sdgb:lanes:<lane>:membership-epoch              monotonic counter
sdgb:maintenance:<requestId>                    hot maintenance view, TTL
```

`desired-members` 由当前 control-plane reconciler 写入并续 TTL。它是 membership acquire 的授权集合，不是 job 路由表。

## 4. Per-worker Membership Lease

```ts
type LaneMembershipLease = {
  lane: "probe" | "interactive";
  workerId: string;
  token: string;
  membershipEpoch: number;
  processGeneration: string;
  networkEpoch: number;
  ttlMs: number;
  acquiredAt: string;
};
```

默认：

```text
TTL = 30s
renew every = 10s
```

激活流程：

1. Reconciler 选择 worker，递增 lane 的 `membership-epoch`，把 workerId、state=active 和 epoch 写入 `desired-members`。
2. Worker 从 heartbeat response 读取 expected epoch。
3. Worker 通过 Redis 原子脚本创建自己的 member key。
4. 脚本验证 desired entry、fresh heartbeat、health、capability、class、generation 和 networkEpoch。
5. Key 成功创建后，Worker resume 本地 lane consumer，并在下一次 heartbeat 报告 active。

Renew 必须确认 desired entry 仍为 active 且 epoch 一致，并同时比较 token、membershipEpoch、processGeneration 和 networkEpoch。Release 使用 compare-and-delete，禁止直接删除其他 member key。

每次重新加入 member set 都分配新 epoch。一个 worker 丢失 membership 只 pause 自己的本地 consumer；同一 lane 的其他 member key 和 consumer 不受影响。

## 5. Desired Set Reconcile

固定 class priority：

```text
probe:       recoverable -> stable
interactive: stable -> recoverable
```

候选过滤：

- heartbeat fresh；
- upstream healthy、breaker closed；
- capability 匹配；
- lifecycle=running；
- 版本兼容；
- publicIp 已验证且无冲突；
- 当前没有该 lane/worker drain。

对每条 lane：

1. 保留仍 eligible 的 preferred active member。
2. 从 preferred class 补足到 `preferredActiveCount`。
3. preferred active count 大于 `0` 时，不用 fallback 补缺口；例如目标为 3、当前只有 1 个 preferred，仍只由这 1 个消费。
4. preferred active count 等于 `0` 时，保留并补足 fallback 到 `fallbackActiveCount`。
5. preferred 恢复时，确认至少一个 preferred membership active，然后把所有 fallback desired state 改为 draining。

同 class 排序：保留现有 active member → lane preference → active job 数 → healthy 持续时间 → workerId。排序必须确定性，避免重复切换。

Fallback 的 `draining` membership 可暂时存在来 fence 已领取 job，但其 consumer 已 pause，不计入 active count，也不能 claim 新 job。

## 6. Execution Fencing

Active job 保存：

```ts
type ExecutionFence = {
  lane: SdgbLane;
  workerId: string;
  executionToken: string;
  membershipToken: string;
  membershipEpoch: number;
  processGeneration: string;
  networkEpoch: number;
};
```

检查点：

- 领取 BullMQ job并读取 Mongo 后；
- 等待 request scheduler 后；
- 每次外部请求前；
- 写 requeue/terminal 前；
- session phase 转换前。

Fence 失效时 pause 该 lane 的本地 consumer。Rival/Map abort/requeue；用户 job 按 graceful 规则完成或 cleanup。Mongo terminal/requeue update 还必须匹配 executionToken，防止旧 attempt 覆盖新 attempt。

## 7. BullMQ 分流

- 每条 lane 的所有 active member 使用相同 queue name。
- Consumer concurrency 由各 worker class 配置；BullMQ 将不同 waiting job 发给有容量的 consumer。
- 不增加按 worker 的子队列、job 定向字段或分布式负载均衡器。
- 单 job 的 BullMQ lock 只属于一个 consumer；membership 允许的是多 worker 并行处理不同 job。
- 流量不保证严格均分。验收只要求多个 active member 都能持续获得 job，且任一 member 退出后其余 member继续处理。

## 8. Recoverable 请求策略

以下限制按每个 Recoverable worker/public IP 执行：

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
- 在 breaker open 后关闭本进程 request gate；
- 只移除故障 member，不暂停其他 worker；
- 等待受影响 lane 有非目标 active coverage 后才执行 Auto Recovery；
- 禁止无延迟无限 retry。

多个 Recoverable active member 的 aggregate concurrency 是各 worker 配置之和。

## 9. Stable 请求策略

以下限制按每个 Stable worker/public IP 独立执行：

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

Job-type 数值是 ceiling，该 worker 的 root global 始终 authoritative。

Stable 使用三个独立 wait queue：

```text
cleanup > interactive > probe
```

Token 分配：

1. Cleanup 有 waiter：给 cleanup。
2. 否则 Interactive 有 waiter：给 Interactive。
3. 否则给 Probe。

Probe 可借用本 worker 空闲容量，但不能预占未来 token。Interactive 到达后获得该 worker 的下一个 token。Probe concurrency cap 必须为 Interactive 保留连接和 semaphore slot。

多个 Stable member 会使 aggregate 上限成为 `成员数 × 1.5 QPS`。本实现不使用跨 worker/site-wide distributed limiter。

## 10. Public IP / Network Epoch

Worker 发现 publicIp 变化：

1. `networkEpoch += 1`。
2. health 变为 unknown。
3. 该 worker 的所有 membership renew 因 networkEpoch 不匹配而失败。
4. 其他 worker membership 保持不变。
5. 完成健康验证后重新 eligible，并以新 membership epoch 加入 desired set。

Public IP 不进入时序指标 label，只进入 worker status 和 incident attrs。

## 11. Redis 故障

- Registry/membership Redis 不可用时不领取新 job。
- Membership renew 失败立即 pause 对应本地 lane。
- 其他仍能续约的 worker 继续消费。
- Stable 本地 limiter 或 Recoverable semaphore 继续约束正在收尾的安全步骤。
- Session job 只允许执行 cleanup。
- Redis 恢复后重新 heartbeat/acquire，不能沿用旧内存 token 或 epoch。

## 12. 指标

```text
sdgb_worker_registry_age_seconds{workerId}
sdgb_worker_health{workerId,state}
sdgb_worker_breaker_state{workerId,state}
sdgb_worker_auto_recovery_state{workerId,state}
sdgb_lane_member{lane,workerId,workerClass,state}
sdgb_lane_active_members{lane,workerClass}
sdgb_lane_membership_epoch{lane,workerId}
sdgb_lane_membership_change_total{lane,result,reason}
sdgb_stable_rate_wait_seconds{workerId,trafficClass}
sdgb_fence_rejected_total{lane,jobType}
```
