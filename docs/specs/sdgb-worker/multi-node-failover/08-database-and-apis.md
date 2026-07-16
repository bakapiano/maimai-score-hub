# 数据库与内部 API

[← 返回总览](./README.md)

## 1. 存储原则

- MongoDB 保存需要跨 Redis 丢失、Backend 重启和运维审计恢复的业务/控制状态。
- Redis 保存 heartbeat、lane lease、breaker 当前值、drain desired state 和命令投递等短期运行态。
- ClickHouse/现有 observability 保存高频历史事件和指标，不为每个 heartbeat 写 Mongo。
- 不在任何新增 collection、Redis key 或 API 中保存上游地址、凭据、原始请求/响应或设备实现细节。

首版存储改动：

```text
modify sdgb_jobs
add    sdgb_worker_configs
add    sdgb_maintenance_runs
add    sdgb_worker_incidents
```

不新增 `sdgb_lane_assignments` 或 `sdgb_worker_commands` Mongo collection：lane owner 和命令是 Redis 运行态，持久恢复分别来自 maintenance/incident/job desired state。

## 2. `sdgb_jobs` 扩展

### 2.1 Routing

```ts
lane: "probe" | "interactive" | "session";
routingVersion: number;
```

Job 创建时固化 lane。Repair/retry 不按最新映射重新计算。

### 2.2 Execution Fence

```ts
executionToken: string | null;
executionWorkerId: string | null;
executionLeaseEpoch: number | null;
executionNetworkEpoch: number | null;
claimedAt: Date | null;
executing: boolean;
```

Worker claim 和 terminal/requeue patch 必须 compare execution token。

### 2.3 Retry

```ts
attempt: number;
maxAttempts: number;
retryAt: Date | null;
retryReason: string | null;
failureClass:
  | "empty_response"
  | "network_error"
  | "timeout"
  | "http_rejected"
  | "invalid_response"
  | "outcome_unknown"
  | "canceled"
  | "lease_lost"
  | null;
lastWorkerId: string | null;
```

Retry waiting 使用 `status=queued + retryAt`；BullMQ job 进入 delayed。

### 2.4 Cancellation / Ambiguous Outcome

```ts
cancelRequestedAt: Date | null;
cancelRequestedBy: string | null;
cancelReason: string | null;
cancelRequestId: string | null;
canceledAt: Date | null;
cancelDisposition:
  | "not_requested"
  | "removed_before_start"
  | "aborted_read_only"
  | "cleanup_required"
  | "outcome_unknown"
  | "too_late";
outcomeUnknown: boolean;
```

Status 增加 `canceled`。现有 completed/failed 行为不变。

### 2.5 Index

```text
{ status: 1, lane: 1, retryAt: 1, createdAt: 1 }
{ executionWorkerId: 1, status: 1 }
{ cancelRequestedAt: 1, status: 1 }
{ lane: 1, createdAt: -1 }
```

保留现有 job TTL。TTL 不得早于 retry/cancel/cleanup 的最大业务窗口。

## 3. `sdgb_worker_configs`

持久化允许接入控制面的 worker 定义，不保存 heartbeat：

```ts
type SdgbWorkerConfig = {
  workerId: string;
  enabled: boolean;
  workerClass: "recoverable" | "stable";
  capabilities: Array<"probe" | "interactive" | "session">;
  lanePreferences: Partial<Record<SdgbLane, number>>;
  autoRecoveryHookKind: string | null;
  stableRatePolicy: StableRatePolicy | null;
  minVersion?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
};
```

约束：

- `workerId` unique。
- Recoverable 必须有 `autoRecoveryHookKind`，`stableRatePolicy=null`。
- Stable 必须有合法 `stableRatePolicy`，`autoRecoveryHookKind=null`。
- Capability 变更只影响下一次 assignment，不强行中断 active job；需要 drain 的变更由控制面执行。
- 文档不保存 hook 的设备凭据；这里只保存非敏感 adapter 名称。

Index：

```text
unique { workerId: 1 }
{ enabled: 1, workerClass: 1 }
```

## 4. `sdgb_maintenance_runs`

计划内维护、Auto Recovery 和 worker upgrade 的持久状态：

```ts
type SdgbMaintenanceRun = {
  requestId: string;
  targetWorkerId: string;
  affectedLanes: SdgbLane[];
  hookKind: string;
  reason: "scheduled" | "manual" | "network_recovery" | "deploy";
  source: "orchestrator" | "admin" | "incident";
  state: MaintenanceState;
  selectedStandbyByLane: Partial<Record<SdgbLane, string>>;
  ownersBefore: Partial<Record<SdgbLane, string>>;
  ownersAfter: Partial<Record<SdgbLane, string>>;
  hookObservation?: {
    hookAccepted: boolean;
    connectivityRestored: boolean;
    publicIpBefore?: string;
    publicIpAfter?: string;
    completedAt: string;
  };
  healthVerification?: {
    successes: number;
    failures: number;
    windowStartedAt: string;
    completedAt?: string;
  };
  deadlineAt: Date;
  errorCode?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};
```

Index/retention：

```text
unique { requestId: 1 }
{ state: 1, updatedAt: 1 }
{ targetWorkerId: 1, createdAt: -1 }
TTL completedAt: 180 days（仅 terminal 行）
```

同一 target worker 同时只允许一个非 terminal maintenance run。使用 partial unique index 或事务/锁保证。

## 5. `sdgb_worker_incidents`

保存 breaker、lease lost、fatal cleanup 等需要 failover/恢复的事件状态：

```ts
type SdgbWorkerIncident = {
  incidentId: string;
  kind: "empty_response" | "lease_lost" | "worker_stale" | "cleanup_fatal";
  state: "open" | "handling" | "resolved" | "dismissed";
  workerId: string;
  workerClass: "recoverable" | "stable";
  publicIp?: string;
  networkEpoch: number;
  affectedLanes: SdgbLane[];
  consecutiveCount?: number;
  observationWindowMs?: number;
  activeJobsByType: Partial<Record<SdgbJobType, number>>;
  failoverWorkerId?: string;
  maintenanceRequestId?: string;
  errorCode?: string;
  openedAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
};
```

Index/retention：

```text
unique { incidentId: 1 }
{ workerId: 1, state: 1, openedAt: -1 }
partial unique { workerId: 1, kind: 1, state: 1 } where state=open
TTL resolvedAt: 90 days（仅 terminal 行）
```

原始上游响应不进入 incident。

## 6. Redis 运行态

```text
sdgb:workers:<workerId>                 heartbeat, TTL
sdgb:workers:<workerId>:drain           desired drain state
sdgb:workers:<workerId>:health          breaker/current health
sdgb:workers:<workerId>:recovery        Auto Recovery current state
sdgb:lanes:<lane>:owner                 owner token + epoch, TTL
sdgb:lanes:<lane>:epoch                 monotonic counter
sdgb:lanes:<lane>:desired-owner         planned handoff hint, TTL
sdgb:control:<workerId>:commands        per-worker Redis Stream
sdgb:control:<workerId>:acks            optional short ack stream
sdgb:maintenance:<requestId>            hot maintenance view, TTL
```

命令事实来自 Mongo desired state：

- Drain 来自 maintenance run/worker config。
- Cancel 来自 sdgb_jobs cancel fields。
- Recovery 来自 open incident + maintenance run。

Redis Stream 丢失后 reconciler 根据 Mongo 重建未完成命令，因此不新增 command collection。

## 7. Worker API

继续使用 worker 身份认证。

| Method | Path                           | 说明                                                                                                                                                        |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/workers/sdgb/jobs/heartbeat` | 扩展为 v2 heartbeat：workerClass、lifecycle、capabilities、active/draining lanes、publicIp/networkEpoch、health、lease、active job、recovery/limiter 状态。 |
| POST   | `/workers/sdgb/incidents`      | 幂等提交 WorkerIncident；返回 incidentId、当前处理状态。                                                                                                    |
| POST   | `/workers/sdgb/control/acks`   | 上报 drain/activate/verify/cancel command ack。                                                                                                             |
| GET    | `/workers/sdgb/jobs/:jobId`    | 返回 lane、attempt、retry、cancel、execution fence 等 worker 所需字段。                                                                                     |
| PATCH  | `/workers/sdgb/jobs/:jobId`    | 扩展 guarded patch：processing、requeue、retry metadata、cancel disposition、terminal；必须带 executionToken。                                              |

Heartbeat 缺少 workerId/workerClass 或与 `sdgb_worker_configs` 不一致时拒绝。Worker API 不返回 hook 设备配置。

## 8. Orchestrator API

供 `MaintenanceHook` orchestrator 使用独立内部凭据；接口立即返回状态，不同步阻塞等待完整维护。

| Method | Path                                                          | 说明                                                              |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| POST   | `/internal/sdgb/maintenance-runs`                             | 以 requestId 幂等创建 maintenance。                               |
| GET    | `/internal/sdgb/maintenance-runs/:requestId`                  | 查询状态、standby、owner 和 `hookMayRun`。                        |
| POST   | `/internal/sdgb/maintenance-runs/:requestId/hook-observation` | Orchestrator 主动、幂等提交 hook 结果摘要。                       |
| POST   | `/internal/sdgb/maintenance-runs/:requestId/verify`           | 请求控制面开始/重试独立健康验证；不直接声明成功。                 |
| POST   | `/internal/sdgb/maintenance-runs/:requestId/abort`            | 仅在状态允许时 abort；hook 可能已执行时转 degraded/verification。 |

Create body：

```ts
type CreateMaintenanceRequest = {
  requestId: string;
  targetWorkerId: string;
  affectedLanes: SdgbLane[];
  hookKind: string;
  reason: "scheduled" | "manual" | "network_recovery" | "deploy";
  deadlineAt: string;
};
```

Hook observation 不决定 handback；控制面仍按健康检查与 class priority 推进。

## 9. Admin API

复用现有 Admin 认证和审计：

| Method | Path                                       | 说明                                                                                |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| GET    | `/admin/sdgb/workers`                      | Worker config + live heartbeat、class、capability、lane、health、limiter/recovery。 |
| POST   | `/admin/sdgb/workers/:workerId/drain`      | 创建幂等手工 drain maintenance。                                                    |
| POST   | `/admin/sdgb/workers/:workerId/undrain`    | 仅在健康/lease 条件允许时恢复 eligibility。                                         |
| GET    | `/admin/sdgb/lanes`                        | Lane policy、owner epoch、standby 候选、queue depth/age。                           |
| GET    | `/admin/sdgb/incidents`                    | 查询 open/history incidents。                                                       |
| GET    | `/admin/sdgb/maintenance-runs`             | 查询维护与 Auto Recovery 历史。                                                     |
| POST   | `/admin/sdgb/incidents/:incidentId/verify` | 请求 half-open 健康验证。                                                           |
| POST   | `/admin/sdgb/jobs/:jobId/cancel`           | 管理员按 job 语义请求取消。                                                         |

Admin 操作只写 desired state/command，不直接修改 Redis owner key。

## 10. 用户 API

首版只为当前用户拥有的 Interactive job 提供可选取消：

| Method | Path                                   | 说明                                                                   |
| ------ | -------------------------------------- | ---------------------------------------------------------------------- |
| POST   | `/me/cabinet-score-jobs/:jobId/cancel` | 使用 requestId 幂等请求取消；返回 accepted 和当前 cancel disposition。 |

用户不能取消 Probe、其他用户 job、cleanup 或 maintenance。取消 accepted 不等于 session 已安全终止。

## 11. 状态码与幂等

| 场景                              |                   Status |
| --------------------------------- | -----------------------: |
| 创建异步 maintenance/cancel       |                      202 |
| 重复相同 requestId                |          200，返回原对象 |
| 状态不允许的 handoff/abort/cancel |                      409 |
| worker config 不存在/disabled     | 403 或 404，按认证层约定 |
| schema/enum/execution token 错误  |                  400/422 |
| execution token/fence 已被替换    |                      409 |

所有 mutation API 接受 requestId；相同 requestId + 不同 body 返回 409。

## 12. Reconciler

Backend 多副本通过 Redis maintenance lease 运行 reconciler：

- 非 terminal maintenance run 没有对应热状态时重建；
- open incident 没有 failover command 时重建；
- cancelRequestedAt 存在但 worker 未 ack 时重新通知；
- queued retryAt 到期但 BullMQ job 缺失时修复；
- Registry stale 时推进 worker_stale incident；
- 不直接完成 hook 或伪造 health success。

## 13. Migration

1. 给 `sdgb_jobs` 新字段加 nullable/default，不立即改变 worker 行为。
2. 后台建立索引，验证 explain/写入延迟。
3. 为现有机器创建 `sdgb_worker_configs`。
4. 发布 v2 heartbeat/incident API，先 shadow 记录。
5. 回填 active job 的 lane/routingVersion；历史 terminal job 可不回填全部 execution metadata。
6. 开启 maintenance/incident reconciler。
7. 开启 command stream、lease enforcement、retry/cancel。
8. 删除迁移期 nullable fallback；新 job 强制 lane/execution fields。

## 14. 不新增的表

| 不新增                   | 原因                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `sdgb_worker_heartbeats` | 高频运行态，Redis TTL + observability 足够。                       |
| `sdgb_lane_assignments`  | 当前 owner 是短 lease，Mongo 快照容易过期误导。                    |
| `sdgb_worker_commands`   | Desired state 已在 maintenance/incident/job；Redis Stream 可重建。 |
| `sdgb_rate_buckets`      | Stable limiter 在单 worker 进程内；首版没有分布式 rate bucket。    |
| raw response table       | 安全与容量风险；只保存分类和安全 metadata。                        |
