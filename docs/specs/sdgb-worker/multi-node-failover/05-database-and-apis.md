# 数据库与内部 API

[← 返回总览](./README.md)

## 1. 存储范围

本实现只做：

```text
modify sdgb_jobs
add    sdgb_maintenance_runs
```

Heartbeat、worker health/breaker、desired member set、每 worker 的 lane membership、desired drain 和 maintenance 热状态放 Redis。Incident 历史复用现有 observability，不新增 incident/config/command collection。

## 2. `sdgb_jobs` 扩展

### 2.1 Routing/Fence

```ts
lane: "probe" | "interactive";
routingVersion: number;
executionToken: string | null;
executionWorkerId: string | null;
executionMembershipEpoch: number | null;
executionNetworkEpoch: number | null;
```

`executionMembershipEpoch` 是 claim 该 attempt 的 worker/lane membership epoch，不代表 lane 只有一个 worker。Terminal/requeue patch 以 executionToken 为 Mongo 原子 guard；worker 在发请求前另行验证 Redis membership token 与 epoch。

### 2.2 Retry/Outcome

```ts
attempt: number;
maxAttempts: number;
retryAt: Date | null;
retryReason: string | null;
failureClass:
  | "empty_response"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "outcome_unknown"
  | "membership_lost"
  | null;
lastWorkerId: string | null;
outcomeUnknown: boolean;
```

不增加通用 canceled status/字段。Probe abort 使用 queued + retry metadata；用户 job 继续使用现有终态和 session cleanup 字段。

### 2.3 Index

```text
{ status: 1, lane: 1, retryAt: 1, createdAt: 1 }
{ executionWorkerId: 1, status: 1 }
{ lane: 1, createdAt: -1 }
```

保留现有 TTL；TTL 必须覆盖最大 retry/cleanup 窗口。

## 3. `sdgb_maintenance_runs`

```ts
type LaneCoveragePlan = {
  workerClass: "recoverable" | "stable";
  targetCount: number;
  selectedWorkerIds: string[];
};

type SdgbMaintenanceRun = {
  requestId: string;
  targetWorkerId: string;
  affectedLanes: Array<"probe" | "interactive">;
  hookKind: string;
  reason: "scheduled" | "manual" | "network_recovery" | "deploy";
  state:
    | "requested"
    | "planning_coverage"
    | "draining_target"
    | "coverage_activating"
    | "coverage_ready"
    | "hook_running"
    | "recovery_verifying"
    | "restoring_membership"
    | "completed"
    | "aborted"
    | "degraded_coverage_active";
  coveragePlanByLane: Partial<Record<SdgbLane, LaneCoveragePlan>>;
  activeMembersBeforeByLane: Partial<Record<SdgbLane, string[]>>;
  activeMembersAtHookByLane: Partial<Record<SdgbLane, string[]>>;
  activeMembersAfterByLane: Partial<Record<SdgbLane, string[]>>;
  hookObservation?: {
    hookAccepted: boolean;
    connectivityRestored: boolean;
    publicIpBefore?: string;
    publicIpAfter?: string;
    completedAt: string;
  };
  healthSuccesses: number;
  healthFailures: number;
  healthWindowStartedAt?: Date;
  deadlineAt: Date;
  errorCode?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};
```

`coveragePlanByLane` 保存本次 maintenance 为非目标 coverage 选择的 class、目标数量和 worker 列表。三个 snapshot 都是数组，因此能够表达 lane 的多 active member。

Index：

```text
unique { requestId: 1 }
{ state: 1, updatedAt: 1 }
{ targetWorkerId: 1, createdAt: -1 }
TTL completedAt: 180 days（terminal only）
```

同一 target worker 同时只允许一个非 terminal maintenance run。

## 4. Redis Keys

```text
sdgb:workers:<workerId>                         heartbeat, TTL
sdgb:workers:<workerId>:health                  breaker/current health
sdgb:workers:<workerId>:drain                   desired drain
sdgb:workers:<workerId>:recovery                Auto Recovery state
sdgb:lanes:<lane>:desired-members               desired workerId/state/epoch set, TTL
sdgb:lanes:<lane>:members:<workerId>            membership lease, TTL
sdgb:lanes:<lane>:membership-epoch              monotonic counter
sdgb:maintenance:<requestId>                    hot maintenance view, TTL
```

Worker desired state 通过 heartbeat response 下发，不使用 command stream。每个 member key 独立续约和过期。

## 5. Worker API

| Method | Path                           | 变更                                                                                                             |
| ------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| POST   | `/workers/sdgb/jobs/heartbeat` | 扩展 request；response 返回每条 capability lane 的 desired state 和 expectedMembershipEpoch。                    |
| POST   | `/workers/sdgb/incidents`      | 幂等上报 empty/membership-lost incident；写 observability 并触发 member-set reconcile。                          |
| GET    | `/workers/sdgb/jobs/:jobId`    | 返回 lane、attempt、retry 和 execution membership fence。                                                        |
| PATCH  | `/workers/sdgb/jobs/:jobId`    | 增加 guarded requeue/retry patch，必须匹配 executionToken；membership epoch 不匹配时拒绝新的外部请求或状态推进。 |

Heartbeat request 包含 workerId/class/autoRecoveryHookKind/version/generation、capabilities、laneMemberships、lifecycle、publicIp/networkEpoch、health/breaker/recovery 和 activeJobs。

Heartbeat response：

```ts
type WorkerHeartbeatResponse = {
  desiredLaneMemberships: Partial<
    Record<
      SdgbLane,
      {
        state: "active" | "draining" | "inactive";
        expectedMembershipEpoch?: number;
      }
    >
  >;
  maintenanceRequestId?: string;
};
```

Recoverable 的 hook kind 必须能在 adapter registry 中解析；Stable 不允许配置 hook kind。

## 6. Orchestrator API

使用独立内部认证，异步返回：

| Method | Path                                                          | 说明                                                       |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| POST   | `/internal/sdgb/maintenance-runs`                             | 以 requestId 幂等创建 maintenance。                        |
| GET    | `/internal/sdgb/maintenance-runs/:requestId`                  | 返回状态、coverage plan、active member snapshots 和 gate。 |
| POST   | `/internal/sdgb/maintenance-runs/:requestId/hook-observation` | Orchestrator 主动、幂等提交 hook observation。             |

Create：

```ts
type CreateMaintenanceRequest = {
  requestId: string;
  targetWorkerId: string;
  affectedLanes: Array<"probe" | "interactive">;
  hookKind: string;
  reason: "scheduled" | "manual" | "network_recovery" | "deploy";
  deadlineAt: string;
};
```

GET response 中的 `hookMayRun` 只在 target 已停止 affected lane 新 claim，且每条 lane 都有非目标 active coverage 时为 true。

Hook observation 不直接完成 maintenance；控制面独立执行健康验证和 membership 恢复。

## 7. Heartbeat Reconciler

Backend 多副本通过 Redis leader lease 运行单个 reconciler：

- 按 `LanePolicy` 计算每条 lane 的 desired member set。
- Preferred active count 大于 `0` 时排除 fallback 新 claim；等于 `0` 时激活 fallback。
- Heartbeat stale → 等待该 worker 的 member key 过期，同时保留其他 active member。
- Breaker open incident → 将故障 worker 改为 draining，安全释放其 membership。
- Maintenance 状态推进和 coverage gate。
- retryAt 到期但 BullMQ job 缺失 → repair。
- Worker heartbeat response 返回该 worker 当前 desired membership state。

不新增 Admin mutation API；使用现有状态页面/日志观测。Maintenance orchestrator 只使用 Maintenance API。

## 8. 状态码与幂等

| 场景                              |          Status |
| --------------------------------- | --------------: |
| 创建 maintenance                  |             202 |
| 重复相同 requestId                | 200，返回原对象 |
| 相同 requestId 不同 body          |             409 |
| 当前状态不允许推进                |             409 |
| Heartbeat schema/class 不合法     |         400/422 |
| Execution token/membership 失效   |             409 |
| Worker 不在 desired member set 中 |             409 |

## 9. Migration

1. 给 `sdgb_jobs` 增加 nullable/default 字段和索引，创建 `sdgb_maintenance_runs`。
2. 发布扩展 heartbeat，先只观测 registry 和计算出的 desired member set。
3. 上线 per-worker membership key、epoch 分配和 reconcile，仍保持 consumer 不受 desired state 控制。
4. 回填 active/queued job 的 lane/routingVersion。
5. 启用 Worker 本地 membership gate，确认未授权 member 无法 claim。
6. 启用两条 lane 的多 member消费，并以大于 `1` 的测试配置验证实际分流。
7. 启用 Stable scheduler、MaintenanceHook、empty incident 和 Probe 同 jobId retry。
8. 删除迁移期 nullable fallback，新 job 强制 routing/execution 字段。

## 10. 安全

- WorkerId 必须与认证主体或受控部署配置一致。
- Hook 凭据只存在于 hook 项目，不进入 Backend/Redis/Mongo。
- API/日志不保存外部地址、请求正文或原始响应。
- Incident 只记录 worker、class、publicIp/networkEpoch、failure class、计数、lane/membership epoch 和时间。
- Redis compare-and-set 脚本只能创建/续约调用 worker 自己的 member key。
