# 控制面与数据契约

[← 返回总览](./README.md)

## 1. 边界

控制面由 Backend 多副本提供，负责 worker registry、lane policy、assignment、drain、maintenance、breaker 汇总、cancel 命令和 Admin 查询。

控制面不负责：

- 执行设备重启或网络切换；
- 实现上游业务协议；
- 保存上游凭据或原始响应；
- 在 Backend 进程内持有唯一事实状态。

所有命令可通过受认证的内部 HTTP 或 Redis durable command stream 传输；本文定义语义，不绑定具体 URL。

## 2. Worker 配置

```ts
type StableRatePolicy = {
  globalQps: number;
  burst: number;
  cleanupReservedQps: number;
  interactiveReservedQps: number;
  byJobType: Partial<Record<SdgbJobType, number>>;
  maxConsecutiveProbe: number;
};

type WorkerStaticConfig = {
  workerId: string;
  version: string;
  workerClass: "recoverable" | "stable";
  capabilities: SdgbCapability[];
  lanePreferences: Partial<Record<SdgbLane, number>>;
  autoRecoveryHookKind?: string;
  stableRatePolicy?: StableRatePolicy;
};
```

启动时必须验证：

- workerId 非空且在环境内唯一；
- workerClass 合法；
- capabilities 均为当前版本支持值；
- Recoverable 必须配置 autoRecoveryHookKind，且不接受 Stable rate policy；
- Stable 必须配置合法 strict rate policy，且不自动运行 recovery hook；
- session capability 所需保护依赖可用；
- Registry/Redis/Backend 可达；
- 不在未获得 assignment 时自动 resume exclusive lane。

## 3. Worker Heartbeat

```ts
type WorkerHeartbeat = {
  workerId: string;
  version: string;
  sequence: number;
  sentAt: string;
  workerClass: "recoverable" | "stable";
  capabilities: SdgbCapability[];
  activeLanes: SdgbLane[];
  drainingLanes: SdgbLane[];
  publicIp?: string;
  networkEpoch: number;
  upstreamHealth: UpstreamHealthState;
  breakerState: BreakerState;
  autoRecoveryState?: "idle" | "requested" | "running" | "verifying" | "failed";
  limiterState?: {
    globalQps: number;
    interactiveWaiting: number;
    probeWaiting: number;
  };
  ownedLeases: Array<{
    lane: SdgbLane;
    epoch: number;
    expiresAt: string;
  }>;
  activeJobs: number;
  activeJobsByType: Partial<Record<SdgbJobType, number>>;
  jobsClaimedDelta: number;
};
```

Backend 验证：

- workerId 与认证主体匹配；
- workerClass 与注册时静态配置匹配，运行中不可变；
- sequence 对同一进程单调递增；
- active lane 必须属于 capability；
- owned lease 与 Redis token/epoch 一致；
- publicIp 格式合法，但不能由该字段授予权限；
- 两个 live worker 报告相同 publicIp 时，将它们标记为部署冲突并禁止自动 assignment；
- 过大数组或未知 enum 拒绝。

## 4. Lane Policy

```ts
type LanePolicy = {
  lane: SdgbLane;
  queueName: string;
  mode: "exclusive" | "shared";
  requiredCapabilities: SdgbCapability[];
  preferredWorkerClasses: Array<"recoverable" | "stable">;
  maxActiveWorkers: number;
  failoverEnabled: boolean;
  requireDistinctPublicIpOnFailover: boolean;
  minWorkerVersion: string;
  drainGraceMs: number;
  leaseTtlMs: number;
  leaseRenewMs: number;
};
```

初始 class priority：

```text
probe:       [recoverable, stable]
interactive: [stable, recoverable]
```

Policy 属于代码/受控配置，不允许任意用户动态修改 queueName 或 capability。

## 5. Worker 控制命令

```ts
type WorkerCommand =
  | {
      type: "drain_lane";
      requestId: string;
      workerId: string;
      lane: SdgbLane;
      deadlineAt: string;
      reason: string;
    }
  | {
      type: "activate_lane";
      requestId: string;
      workerId: string;
      lane: SdgbLane;
      expectedEpoch?: number;
    }
  | {
      type: "verify_worker_network";
      requestId: string;
      workerId: string;
      expectedNetworkEpoch: number;
    }
  | {
      type: "cancel_job";
      requestId: string;
      jobId: string;
      reason: string;
    };
```

Command ack：

```ts
type WorkerCommandAck = {
  requestId: string;
  workerId: string;
  state: "accepted" | "running" | "completed" | "rejected" | "failed";
  disposition?: string;
  errorCode?: string;
  updatedAt: string;
};
```

命令必须持久到 worker ack 或过期。Pub/Sub 只能作为唤醒信号，不能是唯一载体。

## 6. Maintenance 控制契约

Orchestrator 使用通用命令：

```ts
type CreateMaintenance = {
  requestId: string;
  targetWorkerId: string;
  affectedLanes: SdgbLane[];
  hookKind: string;
  reason: string;
  deadlineAt: string;
};
```

控制面返回：

```ts
type MaintenanceView = {
  requestId: string;
  state: MaintenanceState;
  targetWorkerId: string;
  selectedStandbyByLane: Partial<Record<SdgbLane, string>>;
  laneOwners: Partial<Record<SdgbLane, string>>;
  hookMayRun: boolean;
  handbackAllowed: boolean;
  errorCode?: string;
  updatedAt: string;
};
```

Orchestrator 只有看到 `hookMayRun=true` 才执行 MaintenanceHook。Hook 完成后提交 observation；控制面独立执行 health verification。

Hook observation 是非敏感摘要：

```ts
type MaintenanceObservation = {
  requestId: string;
  hookAccepted: boolean;
  connectivityRestored: boolean;
  publicIpBefore?: string;
  publicIpAfter?: string;
  completedAt: string;
};
```

控制面不能仅凭 `connectivityRestored=true` handback，仍需 worker heartbeat 与 UpstreamHealthCheck。

## 7. Job 文档扩展

```ts
type SdgbJobExecutionMetadata = {
  lane: SdgbLane;
  routingVersion: number;
  executionToken: string | null;
  executionWorkerId: string | null;
  executionLeaseEpoch: number | null;
  attempt: number;
  maxAttempts: number;
  retryAt: Date | null;
  retryReason: string | null;
  failureClass: UpstreamFailureClass | null;
  outcomeUnknown: boolean;
  cancelRequestedAt: Date | null;
  cancelRequestId: string | null;
  canceledAt: Date | null;
  cancelDisposition: string;
};
```

### 7.1 Claim

Worker 读取 BullMQ job 后，通过 Mongo compare-and-set claim：

```text
status=queued，或 status=processing 且原 execution token 已明确 stale
cancelRequestedAt is null
retryAt <= now
lane matches consumer lane
execution token absent/stale
```

成功后写 workerId、随机 executionToken、leaseEpoch、attempt 和 claimedAt。失败则不执行上游操作。

### 7.2 Terminal Update

Completed/failed/canceled/requeue 都必须匹配：

```text
jobId + executionToken + executionWorkerId
```

Lease epoch 过期时，read-only requeue 可以更新；普通 completed 不允许旧 epoch 覆盖新 owner 结果。

## 8. Admin 查询模型

### 8.1 Worker 列表

至少展示：

- workerId/version；
- workerClass/Auto Recovery 状态；
- capabilities/active lanes/draining lanes；
- current public IP/networkEpoch；
- heartbeat age；
- upstream/breaker state；
- Stable limiter 配置与 Interactive/Probe waiter；Recoverable 显示 unthrottled + concurrency；
- active jobs；
- owned lease/epoch；
- preference 和 eligibility rejection reason。

### 8.2 Lane 列表

- queue depth、oldest age；
- policy mode；
- owner(s)；
- standby 候选顺序；
- current maintenance；
- handoff history；
- rate budget/wait；
- breaker impact。

### 8.3 Job Debug

- lane/routingVersion；
- attempts/retryAt/failureClass；
- execution worker/publicIp/networkEpoch/leaseEpoch；
- cancel state；
- outcome unknown/cleanup state；
- timeline events。

不显示敏感 payload、外部地址、凭据或原始响应。

## 9. 事件

```text
worker_registered
worker_stale
worker_recovered
lane_drain_requested
lane_drained
lane_lease_acquired
lane_lease_lost
lane_handoff_started
lane_handoff_completed
maintenance_hook_started
maintenance_hook_completed
worker_network_verification_started
worker_network_verification_failed
breaker_opened
breaker_half_open
breaker_closed
job_retry_scheduled
job_cancel_requested
job_canceled
job_outcome_unknown
```

事件 attrs 仅使用 ID、enum、计数、epoch 和耗时等安全元数据。

## 10. 权限与安全

- Worker heartbeat/command ack 使用 worker 身份认证，不能仅信任 body 中的 workerId。
- Maintenance 和 drain/undrain 仅允许内部 orchestrator 或管理员权限。
- Cancel 用户 job 仍需验证 owner；基础设施 drain 使用内部权限并记录 reason。
- Redis 不公开给不受信网络；命令、lease 和 rate script 使用最小权限。
- MaintenanceHook 的设备凭据只存在于 hook 运行环境，不进入 Backend、Redis、worker heartbeat 或本文档。
- 日志禁止输出环境变量、控制密钥、敏感请求、原始 upstream 响应。

## 11. 版本协商

Worker heartbeat 带 `version` 和可选 `protocolVersion`。Lane policy 设置 `minWorkerVersion`。

滚动发布顺序：

1. Backend 先接受旧/新 heartbeat，但不启用新 assignment。
2. 新 worker 注册 capability，保持 standby。
3. 所有 active/standby 达到最低版本。
4. 开启 lease/command 新行为。
5. 删除临时兼容解析。

兼容期必须有明确截止版本和删除任务，不能永久保留无 role、无 lane 或无 execution token 的隐式行为。
