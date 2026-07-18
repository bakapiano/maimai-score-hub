# 02 — 自动调度、多 Backend Claim 与执行恢复

## 自动导出调度

### Score Commit 即时 Wake

DXNet、二维码、Rival 和 FC/FS 在 score version 实际增加后都可以：

```ts
void ensureAutoExportWake(friendCode);
```

- 使用稳定、不含冒号的 BullMQ ID：`auto-export-<hashedFriendCode>`；
- waiting/delayed/active delivery 已存在时不重复创建；
- enqueue 失败不影响 score commit；
- no-op 不唤醒。

### 定期 Reconciliation

每 30-60 秒由全局 Redis maintenance lease 选出一个 scanner：

1. 分批读取 enabled state，每批约 500；
2. 批量查询 sync，仅投影 `friendCode/id/__v`；
3. 比较 `lastSuccessVersion < sync.__v`；
4. 尊重 provider `nextAttemptAt`；
5. 为存在版本差的用户确保 BullMQ wake。

Scanner 不 `$lookup` 大 sync 文档。`syncs` 提供窄覆盖索引：

```ts
{ friendCode: 1, __v: 1, id: 1 }
```

## 多 Backend 单用户串行

两层保护：

1. Redis 可续期 user lease 防止外部上传并发；
2. Mongo 原子 claim + claimToken fence state 写入。

```text
load wake/manual job
  -> acquire Redis lease(prober-export-user:<hashedFriendCode>)
  -> atomically claim prober_export_states
  -> read latest sync once
  -> resolve current tokens
  -> export due providers
  -> atomically advance provider cursors
  -> release Mongo claim
  -> release Redis lease
```

Redis lease/state claim 忙时，BullMQ processor 使用：

```ts
await job.moveToDelayed(Date.now() + jitter(2_000, 5_000), job.token);
throw new DelayedError();
```

不得提前把 state/attempt 标成 processing，也不得触发 failed。

## Mongo Claim 与 Fencing

```ts
findOneAndUpdate(
  {
    friendCode,
    $or: [{ claimUntil: null }, { claimUntil: { $lte: now } }],
  },
  {
    $set: {
      claimToken,
      claimedBy: backendInstanceId,
      claimUntil: nowPlus90s,
      heartbeatAt: now,
    },
  },
  { new: true },
);
```

只有获得返回文档的 replica 抢占成功。每 30 秒按 `{ friendCode, claimToken }` 续期。
续期 `modifiedCount=0` 或 Redis lease 丢失时必须 abort。

所有结果、游标推进和 claim release 都必须匹配 `{ friendCode, claimToken }`。旧进程不能
回写 state。

## Execution-Time Latest

取得两层 claim 后只读取一次：

```ts
{
  syncId,
  scoreVersion: __v,
  scores,
}
```

水鱼/LXNS 从同一份 immutable in-memory snapshot 转换，不能分别查询 current。
`exportedScoreVersion` 可以高于 `requestedScoreVersion`，不能更低。

Provider 成功：

```ts
updateOne(
  { friendCode, claimToken },
  {
    $max: {
      'providers.divingFish.lastSuccessVersion': exportedScoreVersion,
    },
    $set: {
      'providers.divingFish.lastAttemptVersion': exportedScoreVersion,
      'providers.divingFish.status': 'idle',
      'providers.divingFish.error': null,
      'providers.divingFish.result': result,
      'providers.divingFish.updatedAt': now,
    },
  },
);
```

一个 provider 成功、另一个失败时只推进成功方。失败方保留旧成功游标并设置指数退避。

Provider 调用结束后，应把所有成功 `$max`、失败状态、结果摘要和 claim 字段清理组合为一次
`updateOne({ friendCode, claimToken }, ...)`。这样游标/结果发布与 claim release 在同一 state
文档内原子完成。若该写入失败，外部可能已成功但游标保持旧值；后续安全重传 latest。

上传期间 sync 更新时，本次记录实际旧版本；scanner 会再次发现新版本。状态展示从 state
读取，不镜像到 `syncs.autoExportResult`。

## Lease、超时与恢复

```text
Redis lease TTL       90 秒
Redis renew           30 秒
Mongo claim TTL       90 秒
Mongo heartbeat       30 秒
Export hard timeout   25 分钟
Abort grace           30 秒
```

两个 provider client 必须接受同一个 `AbortSignal`，网络请求和 backoff sleep 都可中断。

- Backend 崩溃：lease/claim 到期后由另一 replica 接管；
- Lease/claim 丢失：旧执行 abort，终态被 claimToken 拒绝；
- 外部请求可能成功但本地未确认：后续重传 latest，依赖 provider upsert 幂等；
- stale sweeper 仅在 heartbeat/claim 过期且 BullMQ delivery 不 active 时释放；
- 当前无条件 10 分钟 processing reset 必须移除。

## 自动更新与 Queue 的关系

Rival、FCFS、DXNet、二维码全部采用：

```text
score commit increments sync.__v
  -> best-effort per-user wake
  -> reconciliation is the backstop
  -> BullMQ worker exports
```

版本差是 source of truth，queue 是执行器，scanner 是可靠补投。不创建每 score source 一份
durable 自动导出 job。
