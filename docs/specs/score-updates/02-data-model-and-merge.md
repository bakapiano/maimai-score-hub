# 02 — Current Sync 模型与增量 Merge

## Current Sync 模型

`syncs` 继续是一用户一份完整物化视图，不保存每次完整快照。

```ts
type ScoreSourceType =
  | 'dxnet_update_score'
  | 'auto_update_rival'
  | 'auto_update_fcfs'
  | 'cabinet_qr_update'
  | 'manual_score_update';

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

type SyncScore = {
  // 本谱面最近一次成功提交的观测时间，由后端生成；各成绩字段共用。
  observedAt?: Date | null;
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
- 每次成绩观测提交都递增 `__v`，包括仅刷新 `observedAt` 的提交，以保护并发写入。

## 统一提交接口

现有业务方法只负责校验和映射，最终全部调用
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
- Targeted FC/FS 通过谱面 CID 构建 delta，并在每次 CAS 重试时与最新 current 合并。
- 映射不得把“来源未提供”转换成会覆盖旧值的 0/null。

## 谱面身份

```text
scoreKey = musicId + '::' + chartIndex
```

`cid/type/isNew` 和 rating 所需定数使用当前本地 catalog，不允许外部来源覆盖本地身份字段。

## 字段合并

| 字段 | 规则 |
| --- | --- |
| `score` | 本次明确提供的值覆盖旧值，包含下降、归零 |
| `dxScore` | 本次明确提供的值覆盖旧值，包含下降、归零 |
| `fc` | 本次明确提供的已知标记或 `null` 覆盖旧值 |
| `fs` | 本次明确提供的已知标记或 `null` 覆盖旧值 |
| `rating` | 使用最终 achievement 和当前 catalog 定数重新计算 |
| `cid/type/isNew` | 使用当前 catalog 生成或刷新 |
| `observedAt` | 本次成功合并时的后端时间；数值相同也刷新，未观测谱面保留原时间 |

补充规则：

- `undefined` / 字段省略表示本次未提供，保留旧值；显式 `null` 表示观测到空值。
- 未知状态或 DXNet 图标结构解析缺失按未观测处理，已知空图标按 `null` 处理。
- Rival 只提供 achievement / DX Score；FC/FS 专用任务只提供 FC/FS。
- 手动/OCR 四项均可独立省略；空白输入保持省略，数值 `0` 是有效提交值。
- cabinet 的游玩次数和四项成绩均为 0 的占位记录，只更新已存在谱面；有游玩次数的归零成绩正常写入。
- DXNet 全空观测只更新已存在谱面；双空 FC/FS 观测能够清除既有标记。
- 同一 delta 内重复谱面按输入顺序逐字段覆盖，每条记录保持字段缺省语义直到合并。
- 未映射 catalog 的记录跳过并计数，不影响 current 中的旧记录。
- 完整来源列表缺项也不得删除 current 谱面。
- 仅时间变化返回 `no_change` / `changedChartCount=0`，仍持久化并递增 `__v`。
  `scoreUpdatedAt` 及 `score_changes` 仅记录成绩值的实际变化；导出版本对账能够发现新版本。

## Rating 语义

`rating` 是派生字段，不直接从来源取最大值。它必须与最终保留的 achievement 一致。
catalog 定数修正或 achievement 升降都会重新计算 rating。

## 提交顺序与并发

2026-09-16 起采用最后成功提交语义。通过 Mongo `__v` 做 CAS，冲突时重读 current
并重新合并原始部分 delta。来自不同来源的字段可独立更新，未提供的字段始终取重读后的值。

这是提交顺序语义，接受较早抓取、较晚返回的结果成为当前值。
任务缓存继续保留未观测字段的省略状态。历史记录保留下降和标记清除的 before/after 及有符号变化量。

每谱面一个 `observedAt` 表示该谱面最近收到的部分或完整观测；字段级采集时间属于后续独立扩展。
