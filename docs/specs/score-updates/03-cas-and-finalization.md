# 03 — CAS、冲突重试与 Finalization

## CAS 选择

MongoDB 单文档条件更新是原子的。Phase 1 使用 Mongoose 默认 `__v` 作为 compare token，
不新增业务 revision 表。

建议最多即时重试 8 次，使用 10-200ms jitter。Redis 锁可以减少冲突，但不得成为
正确性的唯一保证。

## 提交算法

```ts
async function commitScoreDelta(input: ScoreCommitInput) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const current = await syncModel
      .findOne({ friendCode: input.friendCode })
      .lean();

    const delta = input.buildDelta
      ? await input.buildDelta(current?.scores ?? [])
      : input.mappedDelta!;

    if (!current) {
      const initialScores = mergeScores([], delta);
      assertValidInitialResult(initialScores, input.sourceType);

      try {
        return await syncModel.create({
          id: randomUUID(),
          friendCode: input.friendCode,
          ownerUserId: input.ownerUserId ?? null,
          scores: initialScores,
          lastSourceType: input.sourceType,
          lastSourceId: input.sourceId,
          lastMergedAt: now,
          scoreUpdatedAt: now,
        });
      } catch (error) {
        if (isDuplicateFriendCode(error)) {
          await jitter(attempt);
          continue;
        }
        throw error;
      }
    }

    const merged = mergeScores(current.scores, delta);
    assertMonotonic(current.scores, merged);
    const changes = diffScores(current.scores, merged);

    if (changes.length === 0) {
      const touched = await syncModel.findOneAndUpdate(
        { _id: current._id, __v: current.__v },
        {
          $set: {
            lastSourceType: input.sourceType,
            lastSourceId: input.sourceId,
            lastMergedAt: now,
            ownerUserId: input.ownerUserId ?? current.ownerUserId ?? null,
          },
        },
        { new: true, runValidators: true },
      );

      if (touched) return toNoChangeResult(touched);
      await jitter(attempt);
      continue;
    }

    const updated = await syncModel.findOneAndUpdate(
      { _id: current._id, __v: current.__v },
      {
        $set: {
          scores: merged,
          lastSourceType: input.sourceType,
          lastSourceId: input.sourceId,
          lastMergedAt: now,
          scoreUpdatedAt: now,
          ownerUserId: input.ownerUserId ?? current.ownerUserId ?? null,
        },
        $inc: { __v: 1 },
      },
      { new: true, runValidators: true },
    );

    if (updated) return toUpdatedResult(updated, changes);

    // 旧 current、merged、changes 全部作废。
    await jitter(attempt);
  }

  throw new SyncCommitContentionError(input.friendCode, input.sourceId);
}
```

## 硬性要求

- CAS filter 同时包含 `_id` 和读取到的 `__v`。
- 修改 `scores` 时显式 `$inc: { __v: 1 }`。
- `findOneAndUpdate=null` 只能触发重读重算，不能 blind retry。
- 初始化竞争依赖 `friendCode` 唯一索引兜底。
- 每次失败尝试产生的 merge 和 diff 必须丢弃。
- 达到重试上限后返回可重试错误，不得 stale write，也不得完成来源任务。
- 每次写前执行 `assertMonotonic(before, merged)`。

## 冲突示例

```text
current = S5 (__v=5)

QR:    read S5 -> merge Q -> CAS(5) succeeds -> S6
DXNet: read S5 -> merge D -> CAS(5) fails
DXNet: read S6 -> merge D -> CAS(6) succeeds -> S7

S7 = S5 ⊔ Q ⊔ D
```

完成顺序反过来必须得到相同的成绩值。

## 来源完成顺序

Commit 必须先于业务完成态：

| 来源 | 顺序 |
| --- | --- |
| DXNet `update_score` | completed payload 校验 → sync commit → job completed |
| Targeted FC/FS | CID 结果校验 → sync commit/no-op → job completed |
| Rival 自动更新 | sync commit → probe task completed/state hash 前移 |
| 二维码 | execution/owner/cleanup 校验 → sync commit → sdgb job completed |

当前 `JobService.patch()` 是先把 DXNet job 更新为 completed，再调用 SyncService。实现时必须
所有 `update_score`（全量、定向、FC/FS-only）均使用 commit-first finalization。

若进程在 sync commit 后、来源终态前崩溃，来源重试同一个 completed 请求。重复 delta
经 merge 后成为 no-op，然后安全完成来源任务。

## 幂等与副作用

成绩正确性依赖 join 的幂等性，不要求单独的完整 snapshot receipt：

- 同一 delta 重放不得改变 `scores` 或增加 score version。
- 若 current 已被其他来源更新且已包含本 delta，也可以安全视为满足。
- 自动导出只做稳定的 per-user BullMQ wake；版本 reconciliation 是事实来源，不依赖
  source 级 job 去重。
- 将来的 `score_changes` 按
  `sourceType + sourceId + musicId + chartIndex` 唯一。
- 重复请求不得重复计入成绩提升指标。

score version 实际增加后，来源应 best-effort 调用稳定的 per-user
`ensureAutoExportWake(friendCode)`。enqueue 丢失不影响 correctness；定期比较
`syncs.__v` 与 `prober_export_states.lastSuccessVersion` 会补投。no-op 不需要自动唤醒。
