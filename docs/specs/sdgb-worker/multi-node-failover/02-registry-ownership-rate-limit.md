# Worker Registry、Lane Ownership 与分布式限流

[← 返回总览](./README.md)

## 1. Worker Registry

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
  capabilities: SdgbCapability[];
  activeLanes: SdgbLane[];
  drainingLanes: SdgbLane[];
  egressGroup: string;
  publicIp?: string;
  upstreamHealth: "unknown" | "healthy" | "degraded" | "blocked";
  breakerState: "closed" | "open" | "half_open";
  activeJobs: number;
  activeJobsByType: Partial<Record<SdgbJobType, number>>;
  lastSuccessAt?: string;
  lastEmptyResponseAt?: string;
};
```

`publicIp` 仅用于运维展示和健康判定，不进入 job payload、队列名或 worker identity。

## 2. egressGroup

`egressGroup` 是稳定的网络出口分组：共享 NAT、代理、VPN 或公网出口的进程必须使用同一值。

```text
worker-a + worker-b -> same NAT -> same egressGroup
worker-c            -> independent egress -> another egressGroup
```

用途：

- 共享分布式请求预算；
- 聚合空响应、超时和 breaker 状态；
- Failover 候选去重，避免从一个受限进程切到同一受限出口；
- 记录动态公网 IP 的变化历史；
- 避免同一出口同时承担超出预算的多个 active lane。

公网 IP 变化不会创建新 egressGroup。变化后将该组健康状态置为 `unknown`，必须通过 health verification 才能恢复为 `healthy`。

## 3. Redis Key 设计

以下均使用应用 Redis prefix；示例只表示逻辑结构：

```text
sdgb:workers:<workerId>                 heartbeat JSON, TTL
sdgb:workers:<workerId>:drain           desired drain state, TTL/explicit
sdgb:lanes:<lane>:owner                 owner lease token, TTL
sdgb:lanes:<lane>:epoch                 monotonic fencing epoch
sdgb:lanes:<lane>:desired-owner         optional planned handoff hint, TTL
sdgb:egress:<egressGroup>:health        health/breaker summary, TTL
sdgb:rate:<egressGroup>:global          distributed token bucket
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
  egressGroup: string;
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
3. 写入随机 token、workerId、epoch 和 TTL。
4. 返回完整 lease。

仅当 worker 同时满足以下条件才可 acquire：

- capability 匹配；
- heartbeat 未 stale；
- 未 drain；
- worker/Backend 版本满足 lane 最低版本；
- egress health 为 healthy；
- breaker closed；
- 控制面选择该 worker，或 shared policy 允许竞争。

### 4.2 Renew

Renew 必须 compare token + epoch 后 `PEXPIRE`。任何不匹配、Redis 错误或超时都视为 lease lost。

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
};
```

至少在以下位置检查 fence：

- BullMQ job 被取出、读取 Mongo job 后；
- 等待 type/global limiter 结束后；
- 每次上游调用前；
- 写 terminal result 前；
- 会话型 job 的关键 phase 转换前。

Fence 失效时，只读 job abort/requeue；有副作用或会话型 job 进入各自安全处理，不允许继续普通业务步骤。

## 6. Worker 选择

候选排序建议：

```text
eligible
  -> explicit desired owner first
  -> lane preference ascending
  -> current active lane count ascending
  -> active job count ascending
  -> last successful health check descending
  -> workerId lexical tie-breaker
```

选择算法必须确定性，避免 Backend 多副本同时给出不同目标。最终 ownership 仍以 Redis 原子 lease 为准。

计划内 handoff 可设置短 TTL `desired-owner`，但目标不健康时必须失败，不能绕过 eligibility。

## 7. 分布式 Rate Limit

### 7.1 为什么不能只用本地 bucket

同一 egressGroup 内两个进程各自限制为 N，实际上游流量可能达到 2N。Failover overlap、滚动发布和 `role=all` 都会放大该问题。

### 7.2 原子 Token Bucket

每次上游请求前调用 Redis Lua/Function，以 Redis 时间为准：

```ts
type RateDecision = {
  allowed: boolean;
  retryAfterMs: number;
  remainingTokens: number;
};
```

Bucket key 至少按 `egressGroup` 隔离。可选增加站点全局 budget，但不能在文档或指标中暴露任何上游凭据标识。

规则：

- burst 默认 1；
- cleanup 请求可以使用独立保留预算，但仍计入出口总上限；
- Redis 不可用时 fail closed，不允许退化到每进程本地满速；
- 等待 token 期间必须继续验证 cancel、lease 和 fence；
- Rate limiter 结果进入低基数 metrics，不记录请求正文。

### 7.3 Lane Fairness

同一 worker 同时处理 Interactive 和 Probe 时，建议使用 weighted scheduler：

```text
cleanup     reserved
interactive high weight
probe       normal weight
```

不能让大量 Probe waiter 把 Interactive 请求预先塞满同一个 FIFO gate。实现可使用带优先级的 request scheduler，而不是多个独立 token bucket 相加。

## 8. Redis 故障语义

- Registry heartbeat 写失败：worker 标记 control-plane degraded。
- Owner renew 失败：exclusive lane 立即 fail closed。
- Rate limiter 失败：不发起新上游调用。
- 已建立的会话型 job：仅允许执行安全 cleanup 路径。
- Redis 恢复后，worker 重新注册并竞争 assignment；不能沿用内存中的旧 lease。

## 9. 指标

```text
sdgb_worker_registry_age_seconds{workerId}
sdgb_lane_owner{lane,workerId}
sdgb_lane_lease_epoch{lane}
sdgb_lane_handoff_total{lane,result,reason}
sdgb_egress_health{egressGroup,state}
sdgb_rate_wait_seconds{egressGroup,lane}
sdgb_rate_denied_total{egressGroup,lane}
sdgb_fence_rejected_total{lane,jobType}
```

公网 IP 属于运维属性，不应作为时序指标 label，以免高基数；可放在 worker status detail 或结构化事件 attrs。
