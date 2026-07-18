# 01 — Export State、Token 与 Attempt 模型

## Token 与 Provider Enable

用户文档继续保存：

| 字段 | 含义 |
| --- | --- |
| `divingFishImportToken` | Diving-Fish `Import-Token` |
| `lxnsImportToken` | LXNS `Personal Token` |

`GET /me` 只返回 `hasDivingFishImportToken/hasLxnsImportToken`，不得返回原文。

- 新增 token：upsert state，provider `enabled=true`、`lastSuccessVersion=null`，立即唤醒；
- 删除 token：provider `enabled=false`；
- 更换 token：清空成功版本，向新账号导出完整 current；
- 外部确认 token 失效：清除 user token，并原子禁用 provider。

Diving-Fish 用户名/密码只用于一次性换 token，不持久化。LXNS 由用户直接提供 Personal
Token。

## `prober_export_states`

一个用户一条，不复制 token：

```ts
type ProviderExportState = {
  enabled: boolean;
  lastSuccessVersion: number | null;
  lastAttemptVersion: number | null;
  status: 'idle' | 'processing' | 'failed';
  failureCount: number;
  nextAttemptAt: Date | null;
  error: string | null;
  result: ProberExportProviderResult | null;
  updatedAt: Date | null;
};

type ProberExportState = {
  friendCode: string;
  ownerUserId?: ObjectId | null;
  providers: {
    divingFish: ProviderExportState;
    lxns: ProviderExportState;
  };

  claimToken: string | null;
  claimUntil: Date | null;
  claimedBy: string | null;
  heartbeatAt: Date | null;
  nextReconcileAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
};
```

索引：

```ts
{ friendCode: 1 } unique
{ ownerUserId: 1 } partial
{ nextReconcileAt: 1 }
{ claimUntil: 1 }
```

### 原子性边界

- `syncs` score CAS 与 state 不做跨集合 transaction。
- 两表版本不一致就是 durable 待导出信号。
- State claim、heartbeat、provider 游标和 claim release 都是单文档原子更新。
- Provider 成功版本只用 `$max`，不能普通 `$set`。
- 执行期 state 写入必须匹配当前 `claimToken`。
- State 写失败最多造成重复导出，不得造成游标倒退。

## `prober_export_jobs`

Job 表示一次实际 attempt，不是固定旧 sync 快照。

| 字段 | 含义 |
| --- | --- |
| `id` | attempt ID，唯一 |
| `kind` | `auto` / `manual` |
| `friendCode/ownerUserId` | 用户归属 |
| `syncId` | 稳定 canonical sync ID |
| `requestedScoreVersion` | 创建/wake 观察版本，可为空 |
| `exportedScoreVersion` | claim 后实际上传版本 |
| `targets` | `divingFish` / `lxns` |
| `status` | queued/processing/completed/partial_failed/failed/skipped |
| `attempts/result/error` | 执行次数与完整结果 |
| `claimToken/claimedAt/completedAt` | attempt 审计 |

Auto attempt 在 worker 成功取得用户 lease/state claim 后创建，避免为被合并的每个 score
source 生成记录。Manual job 在 API 接受时立即创建，供用户轮询。

BullMQ payload：

```ts
type ProberExportQueueData =
  | { kind: 'auto'; friendCode: string }
  | { kind: 'manual'; jobId: string; friendCode: string };
```

Auto delivery ID 使用稳定 friendCode hash；manual delivery ID 使用 Mongo attempt ID。
