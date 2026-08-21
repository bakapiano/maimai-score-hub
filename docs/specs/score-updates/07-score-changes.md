# 07 — 单曲成绩变化 Diff

## 范围

Phase 1 只新增 append-only `score_changes`，每条记录表示一个用户、一个谱面在一次成功
score merge 中发生的字段变化。

明确不实现：

- `score_period_reports`；
- 日报、周报、月报、年报预计算；
- 报告 cron 或聚合缓存；
- 完整历史 sync snapshot；
- `score_revisions` 头表；
- 上线前历史 diff 回填。

以后需要周期报告时，再直接基于 `score_changes` 设计独立阶段。

## 设计结论

1. `syncs` 继续作为每用户唯一 current score 物化视图。
2. `score_changes` best-effort 记录成功 CAS 的谱面级 winning diff。
3. 没有变化时不写记录。
4. 写入失败不回滚 current、不影响来源 completed。
5. 历史查询只承诺覆盖功能上线后成功落表的 diff，允许缺口。

## Collection: `score_changes`

```ts
type ScoreChangeSourceType =
  | 'dxnet_update_score'
  | 'auto_update_rival'
  | 'auto_update_fcfs'
  | 'cabinet_qr_update'
  | 'manual_score_update';

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
  changeSetId: string;

  friendCode: string;
  ownerUserId?: ObjectId | null;
  observedAt: Date;

  sourceType: ScoreChangeSourceType;
  sourceId: string;

  syncId: string;
  beforeScoreVersion: number | null;
  afterScoreVersion: number;

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

  createdAt: Date;
};
```

## 索引

```ts
{ id: 1 } unique
{ changeSetId: 1 }
{ friendCode: 1, observedAt: -1 }
{ friendCode: 1, musicId: 1, chartIndex: 1, type: 1, observedAt: -1, _id: -1 }
{ ownerUserId: 1, observedAt: -1 } partial
{ sourceType: 1, sourceId: 1, musicId: 1, chartIndex: 1 } unique
```

## 字段语义

- `changeSetId`：一次成功 CAS 的所有谱面 diff 共用同一个值。
- `sourceType/sourceId`：来源审计和幂等键。
- `syncId`：稳定 canonical current sync ID，不代表历史完整快照。
- `beforeScoreVersion/afterScoreVersion`：成功 CAS 前后的 Mongoose `__v`。
- `before/after`：只保存单曲历史需要的成绩字段。
- 各 delta/rankDelta 在写入时计算，便于后续单曲趋势查询。
- `observedAt` 是系统观察并合并变化的时间，不保证等于真实游玩时间。

## 变化判定

按 `(musicId, chartIndex)` 比较 winning CAS 的 before/after：

- 原来不存在、现在存在：`newChart`；
- achievement 提升：`score`；
- DX Score 提升：`dxScore`；
- FC rank 提升：`fc`；
- FS rank 提升：`fs`；
- 最终派生 rating 变化：`rating`。

普通 merge 只保留更高 achievement、DX Score、FC 和 FS，因此这些 delta 不得为负。
Catalog 定数修正可能使派生 `ratingDelta` 为负，不代表成绩回退。

## 写入流程

所有来源全部接入同一 diff 计算：

1. `createFromJob()`：DXNet `update_score`；
2. `createFromRivalMusic()`：Rival score change；
3. `createFromJob()`：targeted FC/FS；
4. `createFromUserMusic()`：二维码 `get_music_score`。
5. `createFromManualScores()`：登录用户批量提交铺面成绩。

```text
read current sync + __v
map/build source delta
merge delta with current
compute candidate diff(current, merged)
CAS current sync
  conflict -> discard candidate diff, reread and recompute
  success  -> best-effort bulk-upsert winning diff
```

要求：

- diff 基于最终 merged scores，不基于原始抓取结果；
- 失败 CAS 的 candidate diff 永不落表；
- no-op 不写 `score_changes`；
- 使用 `bulkWrite + upsert + ordered:false`；
- 首次同步可能产生大量 `newChart`，按约 500 条分批；
- unique source/chart 索引保证重复投递幂等；
- 写失败只记录日志和指标，不做 outbox、事务或补偿。

## 查询能力

Phase 1 只需要支持：

- 某用户最近发生变化的谱面；
- 某首歌/难度的变化时间线；
- 某次 `changeSetId` 修改了哪些谱面；
- 按 sourceType/sourceId 排查一次 merge 的实际变化。

不提供周期聚合报告 API。

### 当前用户 API

```http
GET /api/v1/me/score-changes
  ?musicId=<string>
  &chartIndex=<0..10>
  &type=<string>
  &limit=<1..100, default 30>
  &cursor=<opaque, optional>
Authorization: Bearer <jwt>
```

- `friendCode` 只能来自 JWT，客户端不能指定；查询始终同时过滤
  `friendCode + musicId + chartIndex + type`。
- 返回 `{ items, nextCursor }`，按 `observedAt DESC, _id DESC` 稳定分页；cursor 是不透明值。
- 响应不暴露 `friendCode`、`ownerUserId`、`sourceId`、`syncId` 或 Mongo `_id`。
- 页面 `/app/scores` 打开成绩详情时立即加载历史；“成绩历史”作为最后一个 section 默认
  折叠。每个 diff 文档独立显示一条，只展示带对应评级图片的达成率、带 DX 星级图片的
  DX 分数，以及对应状态图片的 FC 和 FS `before → after`；空值显示 `N/A`，不展示
  Rating，并明确提示历史只从功能上线后开始积累。
- 删除账号时按 `friendCode` 同步删除该用户的 `score_changes`。

### 全部成绩历史 Feed

```http
GET /api/v1/me/score-history
  ?start=<epoch milliseconds>
  &end=<epoch milliseconds>
Authorization: Bearer <jwt>
```

- `start/end` 都是必填的 UTC epoch 毫秒整数，使用 `[start, end)` 查询；单次范围不得超过
  100 天。API 不接收本地日期字符串，也不根据服务器时区切页。
- 服务端返回该时间窗内按 `observedAt DESC, _id DESC` 排序的全部记录，不使用条数
  `limit` 或 cursor 截断；`hasEarlier` 表示 `start` 之前是否仍有记录。
- `/app/scores` 的“成绩历史”Tab 使用浏览器 `Date` 与当前 IANA timezone，把记录按用户
  本地业务日分组，并以本地时间展示。
- 页面默认查询并缓存最近三个月，常驻横向日期切换条必须选中一个有成绩的业务日；今天
  有记录时默认选今天，否则选已加载范围内最近有记录的一天。切换日期只做前端过滤，
  不再请求 Feed API。
- `[start, end)` 表示前端已经缓存的完整时间窗。“加载更多”每次只查询
  `[start-3个月, start)` 并按 `id` 增量追加，再向前推进 `start`。
- 日期切换条只展示已缓存且实际有记录的日期；“加载更多”每次增量加载前一个三个月窗
  口，成功后把新发现的日期追加到切换条。
- 用户可设置本地换日小时（默认 06:00）以及是否将同一业务日内相同
  `musicId + chartIndex + type` 的记录合并为一条；合并默认开启。
- Calendar API 仍可供其他客户端按 `from/to/timeZone/dayStartHour` 聚合日期；当前成绩
  历史 Tab 不依赖它预判日期，日期和计数直接从已缓存 Feed 记录生成。

### 当日成绩历史图片导出

`GET /api/v1/me/score-exports/history` 接收 `date/start/end/timeZone/dayStartHour`。后端只
查询 JWT 用户在 `[start, end)` 内的 diff，并按 `musicId + chartIndex + type` 合并为最早
`before` 与最新 `after`。PNG 复用 B50 背景、字体、封面和状态素材，按当前成绩历史卡片
语义绘制，每行固定四张；没有当日记录时返回 404。

## 存储与保留

每条只保存单谱面变化，预计数百字节到约 1KB，显著小于保存完整 sync snapshot。

第一阶段不设置 TTL。若未来容量压力增大，再单独制定归档策略；不能在没有产品决策时直接
删除用户单曲历史。
