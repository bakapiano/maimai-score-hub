# 成绩更新、并发合并与 Diff 历史规范

> 状态：已实现并通过本地验收，待发布
>
> 日期：2026-07-17

## 核心结论

本规范支持 DX Net、二维码、Rival 自动更新和 Recent Event FC/FS enrichment 并发产生
结果，但所有来源必须通过同一个增量提交入口修改用户唯一的 current sync。

```text
S(next) = S(latest) ⊔ Delta(source)
```

Phase 1 保持一用户一份 sync，以 `friendCode` 唯一索引定位，使用 Mongo/Mongoose `__v`
执行 CAS：

```text
读取 current + __v
  -> 生成 delta
  -> 与 current merge
  -> update where __v = observedVersion
      -> 成功：commit
      -> 冲突：丢弃旧 merge，读取最新 current 后重新 merge
```

普通成绩提交不得删除已有谱面，也不得降低 achievement、DX Score、FC 或 FS。

## 文档导航

1. [范围、来源与数据不变量](./01-scope-and-invariants.md)
2. [Current Sync 数据模型与增量 Merge](./02-data-model-and-merge.md)
3. [Mongo CAS、冲突重试与 Finalization](./03-cas-and-finalization.md)
4. [导出语义与双模式并行交互](./04-export-and-parallel-ui.md)
5. [上线兼容、Diff 与可观测性](./05-rollout-and-observability.md)
6. [测试、发布与最终验收](./06-testing-and-rollout.md)
7. [单曲成绩变化 Diff](./07-score-changes.md)

## 当前写入范围

| 来源 | 当前入口 |
| --- | --- |
| DXNet `update_score` | `SyncService.createFromJob()` |
| Rival 自动更新 | `SyncService.createFromRivalMusic()` |
| Recent Event FC/FS | `SyncService.mergeRecentEvents()` |
| 二维码 `get_music_score` | `SyncService.createFromUserMusic()` |

四条路径必须全部收口到 `SyncService.commitScoreDelta()`。未来新增来源不得直接写
`syncs.scores`。

## 关键设计决定

- 一用户一份稳定 current sync，不保存每次完整快照。
- Phase 1 使用 `friendCode` 唯一键，同时可选双写 `ownerUserId`。
- 不再执行 `deleteMany + create`，sync `id` 首次创建后保持稳定。
- 使用 Mongoose `__v` CAS，不新增业务 revision 表。
- 完整抓取结果也只能作为 delta；缺失项不代表删除。
- CAS 冲突后必须基于最新 current 重新生成 merge 和 diff。
- 来源任务 commit-first，sync 成功/no-op 后才能进入 completed。
- 成功 CAS 产生的 score diff 尽力落表；失败只记指标，不影响 sync 或来源终态。
- 自动导出以 `syncs.__v` 与 `prober_export_states.lastSuccessVersion` 的差异为事实来源，
  由 scanner 补投 BullMQ，并使用 Redis 用户 lease + Mongo 原子 claim 串行执行。
- 数据层全部通过验收后才放开 DX Net/二维码跨模式互斥。

## 最终验收摘要

- 任意来源完成顺序下，最终 current 等于所有 delta 的 monotonic union。
- 任意已有谱面和更高字段都不会被普通同步删除或降低。
- 首次创建竞争和更新冲突都会重读最新状态后重试。
- 重复 completed 请求幂等。
- DXNet、二维码、Rival、Recent Event 四条路径均无旁路写入。
- 自动导出不会用旧 current 覆盖新 current。
- Frontend 能独立恢复、轮询和展示两个手动任务。
- 登录用户能在成绩详情按当前歌曲/谱面查看一条 diff 一行的变化历史，且接口不能越权
  读取其他用户、其他难度或其他谱面类型。
