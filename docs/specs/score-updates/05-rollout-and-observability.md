# 05 — 上线兼容、Diff 与可观测性

## 不做 Score Change 数据迁移

`score_changes` 尚未上线，因此：

- 不迁移或回填历史 diff；
- 不尝试从 current sync 反推过去的成绩变化；
- 新 collection 从功能启用时开始记录；
- 历史/报告页面必须明确“仅包含上线后被系统观察到的变化”；
- diff 仍是 best-effort，允许存在缺口。

本文件所说的“上线兼容”只针对现有 `syncs` 从 delete/create 切换到稳定单文档 CAS，
不是 score_changes migration。

## 现有 Sync 上线前检查

建立 `friendCode` 唯一索引前执行只读预检：

1. 按 `friendCode` 查找重复 sync。
2. 正常情况下每个 friendCode 只有一份；无重复时不改写任何成绩文档。
3. 若存在并发遗留重复组，使用 monotonic merge 合并全部文档，不能简单丢弃旧成绩。
4. 重复组保留当前最新文档的稳定 `id`。
5. 检查空 scores、非法成绩和找不到 user 的孤儿 sync。
6. 确保 canonical 文档具有数值 `__v`；Mongoose 已生成的正常文档无需改写。

完成异常处理后创建：

```ts
{ friendCode: 1 } unique
```

这一步属于约束加固，不是全表成绩迁移。

## Current Sync 兼容上线

Phase 1 新字段全部先设为 optional：

```text
lastSourceType
lastSourceId
lastMergedAt
scoreUpdatedAt
ownerUserId
```

无需批量回填：

- 下一次成功 commit 自然写入 source/time 字段；
- 旧文档没有 `lastMergedAt` 时，API 临时回退 `updatedAt ?? createdAt`；
- 保留现有 canonical `id`，新代码不再为每次更新生成 id；
- 旧 `jobId` 字段可以保留但停止依赖，确认无消费者后再删除；
- `ownerUserId` 只做可选双写，不属于本阶段切换条件。

滚动部署期间旧 replica 仍可能 delete/create。新 CAS 必须始终按 friendCode 重读，并把
`_id/__v` 不匹配当普通冲突重试；待旧 replica 排空后，canonical id 才进入稳定期。

## ownerUserId 是独立后续项目

Phase 1 仍按 friendCode 唯一定位。切换 ownerUserId 需要单独设计双写、回填、partial unique
index、双读和切主键，不属于本次 score concurrency rollout，也不阻塞 CAS/并行更新上线。

## Score Diff 写入

Diff 只能来自成功 CAS 的 winning attempt：

```text
read current
build delta against current
merge + candidate diff
CAS
  success  -> best-effort bulk-upsert winning diff
  conflict -> discard candidate diff and recompute
```

失败 CAS 的 candidate diff 不得落表。四种 sourceType 包括：

```text
dxnet_update_score
auto_update_rival
auto_update_fcfs
cabinet_qr_update
```

canonical sync id 稳定后，diff 记录使用：

```ts
syncId: string;
beforeScoreVersion: number;
afterScoreVersion: number;
```

不保存对应版本的完整 sync 快照。

### 投递级别

- 不使用 Mongo transaction、outbox 或补偿状态机。
- 只对 winning diff 发起写入。
- 使用 `bulkWrite({ updateOne: { upsert: true } })`。
- `ordered: false`，首次大批量成绩按约 500 条分批。
- 可以少量、有界瞬时重试，不得无限重试。
- 写失败不回滚 current、不让来源失败、不阻止 completed。
- Backend 在来源完成前至少发起一次有超时上限的尝试。
- 进程在 CAS 后崩溃导致 diff 缺失可以接受。

建议唯一索引：

```ts
{
  sourceType: 1,
  sourceId: 1,
  musicId: 1,
  chartIndex: 1,
} unique
```

完整模型见 [单曲成绩变化 Diff](./07-score-changes.md)。

## 运行时保护

每次 CAS 前执行 `assertMonotonic(before, merged)`。违反不变量时：

- 拒绝写入；
- 记录高优先级错误及 sourceType/sourceId；
- 来源不得标记 completed；
- 不得通过重试绕过断言。

日志不得包含二维码、cookie、token 或原始完整成绩 payload。

## 指标

```text
sync_commit_total{sourceType,outcome}
sync_commit_conflict_total{sourceType}
sync_commit_retry_count{sourceType}
sync_commit_exhausted_total{sourceType}
sync_commit_changed_charts{sourceType}
sync_commit_duration_ms{sourceType}
sync_commit_score_count_before{sourceType}
sync_commit_score_count_after{sourceType}
sync_mapping_skipped_total{sourceType,reason}
score_diff_write_total{sourceType,result}
score_diff_rows_total{sourceType,result}
```

结构化日志包含 sourceType/sourceId、friendCode 安全表示、起始/最终 `__v`、冲突次数、
before/after score count 和 changed chart count。

## 告警

- 任意 `sync_commit_exhausted_total > 0`；
- 任意 monotonic invariant violation；
- CAS conflict rate 持续异常升高；
- current sync 出现重复 friendCode；
- 正常 commit 后 score count 下降。
