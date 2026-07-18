# 02 — Current Sync 模型与增量 Merge

## Current Sync 模型

`syncs` 继续是一用户一份完整物化视图，不保存每次完整快照。

```ts
type ScoreSourceType =
  | 'dxnet_update_score'
  | 'auto_update_rival'
  | 'auto_update_fcfs'
  | 'cabinet_qr_update';

type SyncEntity = {
  id: string;                    // 首次创建后稳定
  friendCode: string;            // Phase 1 canonical unique key
  ownerUserId?: ObjectId | null; // 双写预留
  scores: SyncScore[];

  lastSourceType: ScoreSourceType | null;
  lastSourceId: string | null;
  lastMergedAt: Date | null;      // 成功处理来源，包括 no-op
  scoreUpdatedAt: Date | null;    // scores 最近实际变化

  createdAt: Date;
  updatedAt: Date;
  __v: number;                   // 内部 CAS token
};
```

索引：

```ts
{ id: 1 } unique
{ friendCode: 1 } unique
{ ownerUserId: 1 } partial index
```

约束：

- 不再执行 `deleteMany + create`。
- `id` 是稳定 canonical sync id；仅首次不存在时生成。
- 现有 `jobId` 迁移为 `lastSourceId`，兼容期可双写。
- `createdAt` 是首次创建时间，前端“最近同步”改用 `lastMergedAt`。
- `scoreUpdatedAt` 只在成绩变化时更新；导出状态独立存放在
  `prober_export_states`。
- `__v` 只用于成绩 CAS，不进入普通用户 API。
- 非成绩字段更新不得自行递增 `__v`。

## 统一提交接口

现有四个业务方法只负责校验和映射，最终全部调用
`SyncService.commitScoreDelta()`。

```ts
type ScoreDelta = {
  musicId: string;
  chartIndex: number;
  score?: string | null;
  dxScore?: string | null;
  fc?: string | null;
  fs?: string | null;
};

type ScoreCommitInput = {
  friendCode: string;
  ownerUserId?: string | null;
  sourceType: ScoreSourceType;
  sourceId: string;

  mappedDelta?: ScoreDelta[];
  buildDelta?: (currentScores: readonly SyncScore[]) => Promise<ScoreDelta[]>;
};

type ScoreCommitResult = {
  syncId: string;
  scoreCount: number;
  changedChartCount: number;
  outcome: 'created' | 'updated' | 'no_change';
  scoreVersion: number; // 内部使用
};
```

`mappedDelta` 与 `buildDelta` 必须且只能提供一个：

- DXNet、Rival、二维码映射通常不依赖 current，可提前生成 `mappedDelta`。
- Recent Event 的匹配依赖 current，必须使用 `buildDelta`，且每次 CAS 重试都重新匹配。
- 映射不得把“来源未提供”转换成会覆盖旧值的 0/null。

## 谱面身份

```text
scoreKey = musicId + '::' + chartIndex
```

`cid/type/isNew` 和 rating 所需定数使用当前本地 catalog，不允许外部来源覆盖本地身份字段。

## 字段合并

| 字段 | 规则 |
| --- | --- |
| `score` | 解析 achievement 百分比后取数值更大者 |
| `dxScore` | 解析整数后取数值更大者 |
| `fc` | `null < fc < fcp < ap < app` |
| `fs` | `null < fs < fsp < fdx < fdxp` |
| `rating` | 使用最终 achievement 和当前 catalog 定数重新计算 |
| `cid/type/isNew` | 使用当前 catalog 生成或刷新 |

补充规则：

- 未知状态字符串视为没有可用提升，记录指标但不得覆盖已知状态。
- cabinet 中 achievement 与 DX Score 同为 0 的占位记录过滤。
- DXNet 中 achievement 与 DX Score 都缺失的记录过滤。
- 同一 delta 内重复谱面先使用同一 join 规则归并。
- 未映射 catalog 的记录跳过并计数，不影响 current 中的旧记录。
- 完整来源列表缺项也不得删除 current 谱面。

## Rating 语义

`rating` 是派生字段，不直接从来源取最大值。它必须与最终保留的 achievement 一致。
catalog 定数修正可能改变 rating，但 underlying achievement 仍必须单调不降。

## 合并代数

对成绩值字段，merge 必须满足：

```text
幂等：merge(merge(S, A), A) = merge(S, A)
交换：merge(merge(S, A), B) = merge(merge(S, B), A)
结合：merge(merge(S, A), B) = merge(S, merge(A, B))
单调：S <= merge(S, A)
```

元数据不参与交换性比较；它由同一 catalog 确定性生成。
