# 成绩变化历史与周期报告设计

## 背景

当前 `syncs` 集合只保存每个用户最新一份成绩快照。`SyncService` 在
`createFromJob()`、`createFromRivalMusic()` 和 `mergeRecentEvents()` 中读取
上一份 sync，将新抓取结果与旧成绩合并，然后用 `replaceLatestSync()` 删除旧
sync 并插入新 sync。

这个模型适合“查看当前成绩”，但不能回答：

- 最近一次自动更新到底改了哪些谱面。
- 某首歌的成绩变化历史。
- 每日 / 每周 / 每月 / 每年报告里有哪些提升、FC/FS 变化和新游玩谱面。

本设计目标是增加一套 append-only 的成绩变化事件日志，并在后台定时聚合出周期报告。

## 线上规模参考

2026-07-06 线上 Mongo 只读取样：

| 项目 | 当前值 |
| --- | ---: |
| `syncs` 文档数 | 6148 |
| `syncs` 逻辑大小 | ~967.7MB |
| `syncs` storage size | ~244.8MB |
| 单个 sync BSON 平均 | ~165KB |
| 单个 sync BSON p95 | ~393KB |
| 单个 sync 平均成绩条数 | ~1127 |
| 单个 sync p95 成绩条数 | ~2626 |
| 自动更新启用用户 | 1461 |
| 近期完整日 rival hash changed | ~3000 次/天 |

如果每次成绩变化都保存完整 sync 快照，当前量级约 `3000 * 165KB = 495MB/day`
逻辑写入；10k 自动更新用户外推后会明显放大。周期报告只需要变化明细，不需要每次保留完整成绩快照。

## 设计结论

第一阶段推荐：

1. 保留现有 `syncs` 作为最新成绩物化视图。
2. 新增 `score_changes` 作为事实来源，记录每次合并产生的谱面级 diff。
3. 新增 `score_period_reports` 作为报告缓存，后台定时从 `score_changes` 聚合。
4. 暂不新增 `score_revisions` 头表；将批次元信息冗余到每条 `score_changes` 中。

只用 diff 表作为事实来源足够支撑周期报告。报告页面不应每次实时扫 diff，而应读取预计算的 `score_period_reports`。

## Collection: `score_changes`

一条文档代表“某个用户某张谱面在一次成绩合并中的变化”。

```ts
type ScoreChangeSourceType =
  | 'dxnet_update_score'
  | 'auto_update_rival'
  | 'auto_update_fcfs';

type ScoreChangeField =
  | 'score'
  | 'dxScore'
  | 'fc'
  | 'fs'
  | 'rating'
  | 'newChart';

type ScoreChangeValue = {
  score?: string | null;
  dxScore?: string | null;
  fc?: string | null;
  fs?: string | null;
  rating?: number | null;
};

type ScoreChange = {
  id: string;

  // Same value for all changed charts produced by one merge.
  changeSetId: string;

  friendCode: string;
  createdAt: Date;

  sourceType: ScoreChangeSourceType;
  sourceId: string; // DXNet jobId or auto-update taskId.

  previousSyncId: string | null;
  newSyncId: string;

  musicId: string;
  chartIndex: number;
  type: string;

  before: ScoreChangeValue;
  after: ScoreChangeValue;
  changedFields: ScoreChangeField[];

  achievementDelta: number | null;
  dxScoreDelta: number | null;
  ratingDelta: number | null;
  fcRankDelta: number | null;
  fsRankDelta: number | null;
};
```

### 索引

```ts
{ id: 1 } unique
{ changeSetId: 1 }
{ friendCode: 1, createdAt: -1 }
{ friendCode: 1, musicId: 1, chartIndex: 1, createdAt: -1 }
{ sourceType: 1, sourceId: 1, musicId: 1, chartIndex: 1 } unique
```

### 字段说明

- `changeSetId`：一次 sync 合并的批次 ID。没有独立 revision 表时，用它把同一次更新的多条谱面变化串起来。
- `sourceType/sourceId`：用于排查来源和保证幂等。worker 重试 PATCH completed 或调度重试时，不能重复插入同一来源的同一谱面变化。
- `previousSyncId/newSyncId`：把变化记录与现有 `syncs` 快照关联起来。
- `before/after`：只需要保存报告和历史曲线会用到的成绩字段，不保存完整 `SyncScore`。
- `achievementDelta/dxScoreDelta/ratingDelta`：写入时预计算，减少报告聚合时的解析成本。
- `fcRankDelta/fsRankDelta`：按当前 rank 表计算，便于统计新增 FC、AP、FS、FDX 等。

### 变化判定

按 `(musicId, chartIndex)` 建立旧成绩和新成绩的 map。以下任一情况产生一条 `score_changes`：

- 旧成绩不存在，新成绩存在：`changedFields` 包含 `newChart`。
- achievement 变化：`score` 不同。
- DX Score 变化：`dxScore` 不同。
- FC rank 变化：`fc` 不同。
- FS rank 变化：`fs` 不同。
- rating 变化：`rating` 不同。

当前业务合并规则只保留更高 achievement、dxScore、FC rank、FS rank，因此正常情况下 delta 不应为负。若未来支持导入回滚或曲库定数变更，`ratingDelta` 可能为负。

## Collection: `score_period_reports`

一条文档代表某个用户某个周期的一份预计算报告。

```ts
type ScoreReportPeriodType = 'daily' | 'weekly' | 'monthly' | 'yearly';

type ScorePeriodReport = {
  friendCode: string;
  periodType: ScoreReportPeriodType;
  periodKey: string; // daily: 2026-07-06, weekly: 2026-W28, monthly: 2026-07, yearly: 2026.

  status: 'building' | 'ready' | 'failed';
  error: string | null;

  changeCount: number;
  changedChartCount: number;
  newChartCount: number;
  achievementImprovedCount: number;
  dxScoreImprovedCount: number;
  fcImprovedCount: number;
  fsImprovedCount: number;

  totalAchievementDelta: number;
  totalDxScoreDelta: number;
  totalRatingDelta: number;

  payload: {
    topAchievementGains: unknown[];
    topDxScoreGains: unknown[];
    topRatingGains: unknown[];
    newFc: unknown[];
    newFs: unknown[];
    newPlayedCharts: unknown[];
    recentChangeSets: unknown[];
    summary: unknown;
  };

  builtAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
```

### 索引

```ts
{ friendCode: 1, periodType: 1, periodKey: 1 } unique
{ periodType: 1, periodKey: 1, status: 1 }
{ friendCode: 1, periodType: 1, updatedAt: -1 }
```

### 报告内容

后台任务从 `score_changes` 按用户和时间窗口聚合：

- `daily`：本地时区自然日。
- `weekly`：本地时区 ISO week。
- `monthly`：本地时区自然月。
- `yearly`：本地时区自然年。

报告 payload 可以包含：

- achievement 提升最多的谱面。
- DX Score 提升最多的谱面。
- rating 提升最多的谱面。
- 新 FC / AP。
- 新 FS / FDX。
- 新游玩谱面。
- 最近几次 `changeSetId` 的摘要。

报告中的曲名、版本、等级等展示字段可以在构建时 join `musics` 后写入 payload，避免前端打开报告时做大量二次查询。

## 写入流程

`SyncService` 中三条写 sync 的路径都应接入 diff 记录：

1. `createFromJob()`：DXNet `update_score` 完成。
2. `createFromRivalMusic()`：auto-update rival hash changed 后直接合并。
3. `mergeRecentEvents()`：recent event 合并 FC/FS。

推荐流程：

```text
load previous sync
map incoming scores
merge with previous scores
replace latest sync
compute diff(previous scores, merged scores)
bulk insert score_changes
```

注意：

- diff 必须基于最终 `merged scores`，不是基于原始抓取结果。
- 没有变化时不写 `score_changes`。
- `sourceType/sourceId/musicId/chartIndex` 唯一索引用于幂等。
- 如果 `replaceLatestSync()` 成功但 `score_changes` 写入失败，应记录错误日志。第一阶段可以允许报告缺漏，后续再考虑补偿任务。

## 报告构建流程

后台可用 cron 定时构建：

- 每小时重算当天 daily 报告。
- 每天凌晨重算前一天 daily、当前 weekly、当前 monthly、当前 yearly。
- 每周 / 每月 / 每年边界后重算刚结束的周期。

构建时使用 upsert：

```text
upsert score_period_reports status=building
query score_changes by friendCode + createdAt range
aggregate and enrich with music metadata
update score_period_reports status=ready
```

如果构建失败，将 `status=failed` 并写入 `error`。下次 cron 可以重试。

## 数据语义限制

`score_changes.createdAt` 表示系统观测并合并成绩变化的时间，不一定等于玩家真实游玩时间。

自动更新通常会有几分钟到几十分钟延迟，稳定后全量 `update_score` 还可能晚于活动信号约 45 分钟。因此周期报告第一阶段语义应定义为：

> 在该周期内被系统观测到的成绩变化。

如果未来要严格按真实游玩时间生成报告，需要新的数据源提供可靠的 play time。当前 rival score / DXNet friend-vs 数据不足以完整还原真实游玩时间。

## 为什么暂不新增 `score_revisions`

独立 `score_revisions` 头表可以更自然地表达“一次成绩合并事件”，但周期报告的核心查询是按时间窗口扫描谱面变化。第一阶段把 `changeSetId`、`sourceType/sourceId`、`previousSyncId/newSyncId` 冗余到 `score_changes` 中即可满足：

- 单曲历史。
- 最近提升列表。
- 周期报告。
- 同一来源幂等。
- 按批次展示某次更新的变化。

如果后续需要展示“同步历史列表”，包括成功但无成绩变化的同步记录，再补 `score_revisions` 会更合适。

## 存储压力预期

`score_changes` 每条只保存变化字段，预期单条数百字节到 1KB。当前线上约 3000 次成绩变化合并/天，即使每次平均 5-10 条谱面变化，也只是数 MB 到十几 MB/天级别。10k 用户外推后仍显著低于保存完整 sync 快照。

`score_period_reports` 是按用户和周期的缓存表。即使每个用户每天、每周、每月、每年各保留报告，主要增长也来自 daily 报告。报告 payload 应控制大小，例如 top list 限制 20-50 条，避免把完整 diff 明细复制进报告。

第一阶段不建议给 `score_changes` 设置 TTL；用户历史本身是产品功能。如果未来容量压力变大，可以对旧 daily 报告做 TTL 或只保留压缩后的年度汇总，但原始 `score_changes` 尽量长期保留。
