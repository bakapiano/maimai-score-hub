# 数据库与内部 API

[← 返回总览](./README.md)

## 1. 存储范围

首版只做：

```text
modify sdgb_jobs
add    sdgb_maintenance_runs
```

Heartbeat、worker health/breaker、lane lease、desired drain 和 maintenance 热状态放 Redis。Incident 历史复用现有 observability，不新增 incident/config/command collection。

## 2. `sdgb_jobs` 扩展

### 2.1 Routing/Fence

```ts
lane: "probe" | "interactive";
routingVersion: number;
executionToken: string | null;
executionWorkerId: string | null;
executionLeaseEpoch: number | null;
executionNetworkEpoch: number | null;
```

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
  | "lease_lost"
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
type SdgbMaintenanceRun = {
  requestId: string;
  targetWorkerId: string;
  affectedLanes: Array<"probe" | "interactive">;
  hookKind: string;
  reason: "scheduled" | "manual" | "network_recovery" | "deploy";
  state:
    | "requested"
    | "selecting_standby"
    | "draining_owner"
    | "standby_activating"
    | "standby_active"
    | "hook_running"
    | "recovery_verifying"
    | "handback"
    | "completed"
    | "aborted"
    | "degraded_standby_active";
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
sdgb:workers:<workerId>              heartbeat, TTL
sdgb:workers:<workerId>:health       breaker/current health
sdgb:workers:<workerId>:drain        desired drain
sdgb:workers:<workerId>:recovery     Auto Recovery state
sdgb:lanes:<lane>:owner              lease, TTL
sdgb:lanes:<lane>:epoch              monotonic epoch
sdgb:lanes:<lane>:desired-owner      handoff hint, TTL
sdgb:maintenance:<requestId>         hot maintenance view, TTL
```

Worker desired state 通过 heartbeat response 下发，不使用 command stream。

## 5. Worker API

| Method | Path                           | 变更                                                                                                   |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| POST   | `/workers/sdgb/jobs/heartbeat` | 扩展 request；response 返回 desiredActiveLanes、drainLanes、maintenanceRequestId、expectedLeaseEpoch。 |
| POST   | `/workers/sdgb/incidents`      | 幂等上报 empty/lease-lost incident；写 observability 并启动 failover reconciler。                      |
| GET    | `/workers/sdgb/jobs/:jobId`    | 返回 lane、attempt、retry 和 execution fence。                                                         |
| PATCH  | `/workers/sdgb/jobs/:jobId`    | 增加 guarded requeue/retry patch，必须匹配 executionToken。                                            |

Heartbeat request 包含：workerId/class/version/generation、capabilities、active/draining lanes、lifecycle、publicIp/networkEpoch、health/breaker/recovery、activeJobs。

## 6. Orchestrator API

使用独立内部认证，异步返回：

| Method | Path                                                          | 说明                                           |
| ------ | ------------------------------------------------------------- | ---------------------------------------------- |
| POST   | `/internal/sdgb/maintenance-runs`                             | 以 requestId 幂等创建 maintenance。            |
| GET    | `/internal/sdgb/maintenance-runs/:requestId`                  | 返回状态、standby、owners、hookMayRun。        |
| POST   | `/internal/sdgb/maintenance-runs/:requestId/hook-observation` | Orchestrator 主动、幂等提交 hook observation。 |

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

Hook observation 不直接完成 maintenance；控制面独立执行健康验证和 handback。

## 7. Heartbeat Reconciler

Backend 多副本通过 Redis lease 运行 reconciler：

- heartbeat stale → 等待 owner lease 过期 → 选择 standby；
- breaker open incident → drain/release/standby；
- maintenance 状态推进；
- retryAt 到期但 BullMQ job 缺失 → repair；
- Worker heartbeat response 返回当前 desired state。

不新增 Admin mutation API；首版使用现有状态页面/日志观测。Router orchestrator 只使用 Maintenance API。

## 8. 状态码与幂等

| 场景                          |          Status |
| ----------------------------- | --------------: |
| 创建 maintenance              |             202 |
| 重复相同 requestId            | 200，返回原对象 |
| 相同 requestId 不同 body      |             409 |
| 当前状态不允许推进            |             409 |
| Heartbeat schema/class 不合法 |         400/422 |
| Execution token/fence 失效    |             409 |

## 9. Migration

1. 给 `sdgb_jobs` 增加 nullable/default 字段和索引。
2. 发布扩展 heartbeat，先只观测 desired state。
3. 启用 worker registry/lease reconciler。
4. 回填 active/queued job 的 lane/routingVersion。
5. 启用 Stable scheduler、Probe lease 和 handoff。
6. 接入 maintenance API/router hook。
7. 启用 empty incident 与 Probe retry。
8. 删除迁移期 nullable fallback，新 job 强制 routing/execution 字段。

## 10. 安全

- WorkerId 必须与认证主体或受控部署配置一致。
- Hook 设备凭据只存在于 hook 项目，不进入 Backend/Redis/Mongo。
- API/日志不保存外部地址、请求正文或原始响应。
- Incident 只记录 worker、class、publicIp/networkEpoch、failure class、计数、lane 和时间。
