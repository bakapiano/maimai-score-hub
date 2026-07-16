# Worker Registry、Lane Ownership 与限流

[← 返回总览](./README.md)

## 1. 部署约束

第一阶段明确约束：

```text
一个公网出口 = 一个 sdgb-worker 进程
```

- 同一进程可以同时具备 Probe/Interactive capability，并为多条 lane 创建 consumer。
- Stable 的所有 lane 共用严格 request scheduler；Recoverable 不设置软件 QPS 上限。
- Worker 升级使用 stop-start；不做同 IP 的 start-first 双进程滚动。
- 新增机器应有独立公网出口；如果未来不能满足该约束，再引入分布式出口限流。

该约束让限流和 breaker 直接归属 worker，不需要额外 `egressGroup` 概念。

## 2. Worker Registry

每个 worker 周期性上报可过期状态。Registry 是运行态，不是业务事实；Redis 丢失后由 heartbeat 重建。

建议默认：

```text
heartbeat every = 10s
worker stale     = 30s
registry TTL     = 45s
```

Heartbeat：

```ts
type WorkerHeartbeat = {
  workerId: string;
  version: string;
  startedAt: string;
  workerClass: "recoverable" | "stable";
  lifecycleState: "running" | "draining" | "cleanup_handoff_ready" | "blocked";
  capabilities: SdgbCapability[];
  activeLanes: SdgbLane[];
  drainingLanes: SdgbLane[];
  publicIp?: string;
  networkEpoch: number;
  upstreamHealth: "unknown" | "healthy" | "degraded" | "blocked";
  breakerState: "closed" | "open" | "half_open";
  autoRecoveryState?: "idle" | "requested" | "running" | "verifying" | "failed";
  limiterState?: {
    globalQps: number;
    interactiveWaiting: number;
    probeWaiting: number;
  };
  activeJobs: number;
  activeJobsByType: Partial<Record<SdgbJobType, number>>;
  shutdownBlockers?: Array<{
    jobId: string;
    jobType: SdgbJobType;
    phase: string;
  }>;
  lastSuccessAt?: string;
  lastEmptyResponseAt?: string;
};
```

`publicIp` 只用于运维展示、确认 IP 变化和 failover 候选校验，不进入 job payload、queue name 或 worker identity。

Worker 观察到公网 IP 变化时：

1. 增加 `networkEpoch`。
2. 将 upstreamHealth 设为 `unknown`。
3. 暂停获取新的 exclusive lane ownership。
4. 完成 health verification 后才能恢复 `healthy`。

## 3. Redis Key 设计

以下均使用应用 Redis prefix；示例只表示逻辑结构：

```text
sdgb:workers:<workerId>                 heartbeat JSON, TTL
sdgb:workers:<workerId>:drain           desired drain state, TTL/explicit
sdgb:workers:<workerId>:health          health/breaker summary, TTL
sdgb:workers:<workerId>:recovery        Auto Recovery state, recoverable only
sdgb:lanes:<lane>:owner                 owner lease token, TTL
sdgb:lanes:<lane>:epoch                 monotonic fencing epoch
sdgb:lanes:<lane>:desired-owner         optional planned handoff hint, TTL
sdgb:control:commands                    command stream or durable command rows
sdgb:maintenance:<requestId>            maintenance state, TTL + persistence
```

禁止在 key 名中放用户标识、上游凭据或敏感 payload。

## 4. Owner Lease

Exclusive lane lease value：

```ts
type LaneLease = {
  lane: SdgbLane;
  workerId: string;
  token: string;
  epoch: number;
  workerNetworkEpoch: number;
  acquiredAt: string;
};
```

建议默认：

```text
lease TTL = 30s
renew     = 10s
```

### 4.1 Acquire

使用 Redis 原子脚本：

1. 确认 key 不存在。
2. 增加 lane epoch。
3. 写入随机 token、workerId、epoch、networkEpoch 和 TTL。
4. 返回完整 lease。

仅当 worker 同时满足以下条件才可 acquire：

- capability 匹配；
- workerClass 满足当前 lane 的 class priority；
- heartbeat 未 stale；
- 未 drain；
- worker/Backend 版本满足 lane 最低版本；
- upstream health 为 healthy；
- breaker closed；
- 当前 publicIp 已完成验证；
- 控制面选择该 worker，或 shared policy 允许竞争。

### 4.2 Renew

Renew 必须 compare token + epoch + workerNetworkEpoch 后 `PEXPIRE`。任何不匹配、Redis 错误或公网 IP 世代变化都视为 lease lost。

### 4.3 Release

Release 必须 compare-and-delete，旧 owner 禁止直接 `DEL`。

### 4.4 Lease Lost

Worker 立即：

1. 本地暂停对应 BullMQ Worker。
2. 标记 lane 为 draining/lost。
3. 不再领取新 job。
4. 对 active job 执行下一 fencing checkpoint 的处理。
5. 上报 lease-lost event。

## 5. Fencing

仅有 TTL lease 仍无法阻止暂停后恢复的旧进程。每次 ownership 变化都分配单调递增 epoch。

Active job context 保存：

```ts
type JobExecutionFence = {
  lane: SdgbLane;
  leaseToken: string;
  leaseEpoch: number;
  workerId: string;
  workerNetworkEpoch: number;
};
```

至少在以下位置检查 fence：

- BullMQ job 被取出、读取 Mongo job 后；
- 等待 class-specific request scheduler 结束后；
- 每次上游调用前；
- 写 terminal result 前；
- 会话型 job 的关键 phase 转换前。

Fence 失效时，只读 job abort/requeue；有副作用或会话型 job 进入各自安全处理，不允许继续普通业务步骤。

## 6. Worker 选择

Class priority：

```text
probe:       recoverable -> stable
interactive: stable -> recoverable
```

只有高优先级 class 没有 active/healthy/eligible 候选时，才考虑下一 class。

候选排序建议：

```text
eligible
  -> explicit desired owner first
  -> lane workerClass priority
  -> lane preference ascending
  -> current active lane count ascending
  -> active job count ascending
  -> last successful health check descending
  -> workerId lexical tie-breaker
```

对于网络维护或 blocked worker failover：

- 目标必须是另一个 workerId；
- 如果两边 publicIp 均已知，必须不同；
- publicIp 未知时默认不自动接管，除非运维显式放行。

选择算法必须确定性，避免 Backend 多副本同时给出不同目标。最终 ownership 仍以 Redis 原子 lease 为准。

## 7. Worker Class 与请求策略

### 7.1 Recoverable Worker

Recoverable 用于 Probe 主力：

- 不设置软件 QPS 上限；
- 保留有限 worker/type concurrency，避免本机资源耗尽；
- 保留 empty-response circuit breaker；
- Breaker open 后立即 pause/release lane，并触发已配置 Auto Recovery hook；
- Auto Recovery 期间允许 Stable 接管 Probe；
- 不进行无延迟无限重试。

Recoverable 如果临时接管 Interactive，同样不获得 QPS limiter，但 Interactive job 仍按 BullMQ priority 和 type concurrency 执行。该模式只用于没有健康 Stable 的降级状态，必须报警。

### 7.2 Stable Worker

Stable 使用严格分层请求调度器：

```text
root global hard limit
├─ cleanup reserved capacity
├─ interactive reserved capacity
│  ├─ scan_qr type limit
│  ├─ get_music_score type limit
│  └─ add_rival type limit
└─ failover probe best-effort capacity
   ├─ get_rival_hash type limit
   └─ get_user_map type limit
```

要求：

- global burst 默认 1；
- 每个 job type 有独立上限，但子限额相加不能突破 root global；
- Interactive 有保留容量，并优先于 Probe waiter；
- 保留容量采用 work-conserving priority，不是静态分区：Interactive 无 waiter 时 Probe 可借用空闲 token；
- Interactive 到达后必须获得下一个 root token，不能排在已积压的 Probe waiter 后；
- Probe 只能借用当前未被 Interactive/cleanup 使用的 token；
- 出现 Interactive waiter 时，不再发放新的 Probe token，直到保留目标恢复；
- 限制连续 Probe 发放数量，避免 Interactive 在 token 边界饥饿；
- 等待 token 期间继续验证 cancel、lease 和 fence；
- Stable 接管 Probe 时不得动态提高 global 上限。
- Probe consumer/HTTP 并发必须留出 Interactive slot，避免 token 获批后仍被连接池或 semaphore 阻塞；
- 限流只控制每次上游请求的启动，不串行占用整个 job 生命周期。

因此，Stable global 为 `G` 且 burst=1 时，在系统未超过 Interactive 自身容量的前提下，Probe backlog 对新 Interactive 请求增加的 limiter 等待目标上界约为一个 token interval（`1/G`）加调度误差。已发出的请求不可抢占，但未发出的 Probe 请求不能继续排在 Interactive 前面。

现有 promise-chain/FIFO token bucket 不能满足该保证；Stable 实现必须替换为独立 wait queue 的 priority-aware scheduler。仅调整各 job type 的 QPS 数字不足以解决 head-of-line blocking。

初始配置结构：

```ts
type StableRatePolicy = {
  globalQps: number;
  burst: number;
  byJobType: Partial<Record<SdgbJobType, number>>;
  priorityOrder: Array<"cleanup" | "interactive" | "probe">;
  probeBorrowsIdleCapacity: boolean;
  maxConsecutiveProbe: number;
  probeConcurrencyCap: number;
};
```

具体数值由生产观测配置，不写入架构不变量。

### 7.3 部署约束

- 同一公网出口不得启动第二个 worker 进程。
- Recoverable/Stable 都使用 stop-start 发布。
- Stable limiter 配置缺失或非法时启动失败。
- Recoverable Auto Recovery hook 配置缺失时启动失败。

滚动发布必须：

```text
drain old process
→ active jobs reach a job-specific safe point
→ optional lane handoff to another worker
→ stop old process
→ start new process
→ verify health
→ reacquire lane
```

不允许未受控的 start-first overlap，也不允许直接停止仍有 active 用户 job 的进程。

Drain grace 按 job 语义处理，不使用一个很短的统一 kill timeout：

- Rival/Map 可在短 grace 后 abort/requeue；
- QR 类临时输入 job 优先让当前 attempt 在有效期内完成；
- 可能有副作用的 job 请求发出后等待明确结果或 outcome-unknown disposition；
- 会话型 job 必须完成或持久化 cleanup，再允许进程退出。

有健康 standby 时，旧 worker drained/release 后先让 standby 接管 lane，再停止和升级旧进程；新进程健康后按 class priority handback。没有 standby 时，waiting job 保留在 BullMQ，接受短暂排队，但 active job 仍必须 graceful 处理。

## 8. 可选站点全局预算

如果未来确认存在跨 IP 的站点级总配额，可以增加 Redis 全局 token bucket：

```text
sdgb:rate:site-global
```

它是 Stable 本地 strict limiter 和 Recoverable 并发/breaker 之外的可选第二道约束，不用于解决同 IP 多进程；后者仍由部署约束禁止。

第一阶段不实现该全局 budget，也不保留未使用的配置抽象。

## 9. Redis 故障语义

- Registry heartbeat 写失败：worker 标记 control-plane degraded。
- Owner renew 失败：exclusive lane 立即 fail closed。
- 已建立的会话型 job：仅允许执行安全 cleanup 路径。
- Redis 恢复后，worker 重新注册并竞争 assignment；不能沿用内存中的旧 lease。
- Stable limiter 或 Recoverable concurrency/breaker 继续约束当前安全步骤，但控制面失效时不得领取新 exclusive job。

## 10. 指标

```text
sdgb_worker_registry_age_seconds{workerId}
sdgb_worker_class{workerId,class}
sdgb_worker_upstream_health{workerId,state}
sdgb_worker_network_epoch{workerId}
sdgb_worker_auto_recovery_state{workerId,state}
sdgb_lane_owner{lane,workerId}
sdgb_lane_lease_epoch{lane}
sdgb_lane_handoff_total{lane,result,reason}
sdgb_rate_wait_seconds{workerId,lane}
sdgb_rate_denied_total{workerId,lane}
sdgb_stable_reserved_capacity_utilization{workerId,trafficClass}
sdgb_fence_rejected_total{lane,jobType}
```

公网 IP 不作为时序指标 label，以免高基数；只放在 worker status detail 或结构化事件 attrs。
