# 01 — 成绩更新范围、来源与数据不变量

## 背景

当前 `syncs` 是用户最新成绩的物化视图。写入路径会读取 current sync、合并本次
抓取结果，再通过 `deleteMany({ friendCode }) + create()` 替换整份文档。

这在并发下会丢更新：两个写入者可能读取同一份旧 sync，各自完成 merge，后写入者
覆盖先写入者。`deleteMany + create` 还会产生短暂空窗，而 `syncs.friendCode` 当前没有
唯一约束。

统一模型为：

```text
S(next) = S(latest) ⊔ Delta(source)
```

`⊔` 表示只保留更好成绩的增量合并。发生冲突时必须重新读取最新 `S(latest)` 再合并。

## 必须实现

1. 同一用户只保留一份 canonical current sync。
2. 所有普通成绩来源都只能提交 delta，不能替换成绩集合。
3. 来源没有提供的谱面和字段必须保留。
4. achievement、DX Score、FC、FS 不得被较低值覆盖。
5. 所有修改 `syncs.scores` 的路径必须经过同一个提交入口。
6. 使用 MongoDB 单文档条件更新和 Mongoose `__v` 实现 CAS。
7. CAS 冲突后必须重新读取、重新 merge、重新计算 diff。
8. 同一来源重复完成必须保持幂等。
9. 来源任务只有在 sync commit 成功或确认 no-op 后才能进入业务完成态。
10. 数据层通过验收后，DX Net 与二维码任务可以并行执行。

## 非目标

- 本阶段不拆成每谱面一份 Mongo 文档。
- 本阶段不实现成绩降低、删除或回滚。
- 本阶段不全面迁移到 `ownerUserId`；只预留双写字段。
- 本阶段不保存每次完整 sync 快照。成绩历史使用
  [`score_changes`](./07-score-changes.md) 保存字段 diff。
- 本阶段不修改 maimai/cabinet 协议或 standalone sdgb-worker contract。

## 规范用语

- **current sync**：一个用户当前唯一的完整成绩物化视图。
- **delta**：某来源本次观察到的非空成绩字段；完整抓取结果也只能当 delta。
- **source**：由 `sourceType + sourceId` 唯一标识的业务来源。
- **CAS**：Compare-And-Set；更新条件包含读取时的 `__v`。
- **冲突**：CAS 未匹配，说明读取后 current sync 已被其他写入者修改。

## 成绩写入来源

当前所有成绩写入路径：

| sourceType | 生产者 | 当前入口 | 来源字段 | 特殊规则 |
| --- | --- | --- | --- | --- |
| `dxnet_update_score` | DXNet worker | `SyncService.createFromJob()` | achievement、DX Score、FC、FS | 部分难度抓取仍视为 delta |
| `auto_update_rival` | Rival-first scheduler | `SyncService.createFromRivalMusic()` | achievement、DX Score | `fc/fs=null` 表示未提供 |
| `auto_update_fcfs` | targeted `update_score` | `SyncService.createFromJob()` | FC、FS | 按谱面 CID 更新并保留 score/dxScore |
| `cabinet_qr_update` | sdgb `get_music_score` finalizer | `SyncService.createFromUserMusic()` | achievement、DX Score、FC、FS | cleanup 和身份校验成功后才提交 |

每条 current score 还保存可选的 `observedAt`。所有来源使用 winning CAS attempt
的当前时间。只有
achievement、DX Score、FC、FS 的最终最佳值变化才更新，并取 `max(old, incoming)`。
旧 score 缺少有效 `observedAt` 时是唯一例外：该谱面下一次被任一来源观察到便一次性
补齐，推进 score version 并唤醒导出；之后的 no-op 不再刷新。

以下不是成绩写入：

- `prober_export_states` 的 provider 游标和结果不属于成绩写入；
- Best 50、成绩图和查分器转换只读 current sync；
- 账号删除可以删除整份 sync；
- 一次性迁移和经审计的管理员修复属于受控例外。

未来新增来源必须登记 `ScoreSourceType`、只生成标准 delta、调用统一提交入口，并添加
并发、幂等和单调性测试。不得直接注入 model 修改 `scores`。

## 数据不变量

### I1. 单用户单文档

Phase 1 使用 `friendCode` 作为唯一键：

```ts
SyncSchema.index({ friendCode: 1 }, { unique: true });
```

`ownerUserId` 作为可选字段双写，为后续迁移预留。

### I2. 已有谱面不可消失

```text
K(before) ⊆ K(after)
```

来源缺少某首歌、难度或字段，只表示本次没有观察到，不得解释为删除。

### I3. 成绩字段单调不降

对相同 `(musicId, chartIndex)`：

```text
achievement(after) >= achievement(before)
dxScore(after)     >= dxScore(before)
fcRank(after)      >= fcRank(before)
fsRank(after)      >= fsRank(before)
```

`null` 表示没有信息，不得清空已有非空字段。

### I4. 冲突必须基于最新状态重算

若 A 读取 `__v=n` 后，B 已提交 `__v=n+1`，A 必须丢弃旧 `merged/diff`，重新读取
`n+1`、重新生成 delta、merge 和 diff，再使用新的 `__v` CAS。

### I5. 无有效数据不得覆盖

- 映射后没有有效谱面时不得创建空 sync，也不得清空旧 sync。
- 首次同步无有效数据时按来源业务规则失败。
- 已有 sync 且没有提升时可以成功 no-op，但不得改写 `scores` 或增加 score version。

### I6. 普通入口不得降级修复

降低、删除或回滚成绩必须使用独立管理员流程，包含授权、原因和审计，不得复用普通
`commitScoreDelta()`。
