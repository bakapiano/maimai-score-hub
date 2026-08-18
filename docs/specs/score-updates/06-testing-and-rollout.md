# 06 — 验证、发布与最终验收

## Merge 单元和性质测试

必须覆盖：

- delta 缺少谱面时旧谱面保留；
- delta 字段为 null 时旧字段保留；
- 较低 achievement/DX/FC/FS 不覆盖较高值；
- 较高字段分别独立提升；
- 同一 delta 重放为 no-op；
- A/B delta 不同顺序得到相同成绩值；
- 同一 delta 内重复谱面正确归并；
- rating 与最终 achievement 一致；
- unknown catalog/invalid row 不清除已有成绩；
- 空首次结果不创建 sync；
- 普通 commit 后 score key 集合只增不减。

应使用 property-based tests 验证幂等、交换、结合和单调性质。

## CAS 并发测试

使用 barrier 强制两个调用读取同一 `__v`，分别测试：

1. DXNet 与二维码同时完成。
2. DXNet 与 Rival 同时完成。
3. Rival 与 targeted FC/FS 同时完成。
4. 同一 source completed 重复到达。
5. 首次 sync 两个来源同时 create。
6. 两个 Backend replica 同时处理。
7. 连续多次冲突后仍基于最新状态 merge。
8. 达到重试上限时无 stale write、来源不 completed。

每种完成顺序都必须断言最终 current sync 等于所有 delta 的 monotonic union。

## Finalizer 测试

- DXNet job 在 commit 成功前不可 completed。
- Targeted FC/FS job 在 commit/no-op 前不可 completed。
- Rival task 在 commit 前不可前移成功 hash/state。
- QR cleanup 未成功时不进入 commit。
- QR owner/绑定不一致时不进入 commit。
- commit 后终态写入失败，重试不重复提升或重复创建导出 job。

## Score Diff 测试

- 只写成功 CAS 的 winning diff，冲突尝试的 candidate diff 不落表。
- 重复投递依靠唯一键和 upsert 不产生重复行。
- `ordered: false` 时部分重复不影响其他新行写入。
- diff 写入超时或失败不回滚 current，也不阻止来源 completed。
- 首次大批量 diff 正确分批，且不会超过 Mongo 单次写入限制。
- 历史查询能够容忍某个 change set 部分或全部缺失。

## 导出测试

- 两个 Backend replica 同时 claim，同一用户只有一个获得 Mongo claimToken。
- Redis 用户 lease 忙时 BullMQ job 进入 delayed，不标记 failed、不提前 claim state。
- claim heartbeat 只能由当前 claimToken 续期；旧 token 不能写结果或释放 claim。
- provider 成功版本使用 `$max`，任何旧回调都不能把游标写小。
- Provider 游标/结果发布与 claim release 在同一 claimToken 条件更新内原子完成。
- 同一用户两个导出不会并发上传，不同用户仍可并行。
- 一个 execution 中水鱼/LXNS 使用同一份 current snapshot。
- 上传期间 score version 更新后，scanner 能再次发现版本差并补投。
- 即时 queue wake 丢失时，periodic reconciliation 能恢复。
- 多 replica scanner 重复发现时，稳定 BullMQ job ID 不产生重复 active delivery。
- 一个 provider 成功、另一个失败时只推进成功 provider。
- token 新增/替换触发全量 current 导出；删除/失效后停止重试。
- 自动更新、DXNet、二维码都只推进 sync version，并走同一对账/queue 执行链路。
- 手动导出取得相同用户 lease，并在成功后原子推进 provider 游标。
- 导出失败不影响 current sync。
- Redis/Mongo claim 丢失会 abort 外部请求，旧 worker 终态写入被 fencing 拒绝。

## Frontend 测试

- 页面加载时两个 active job 都能恢复。
- DXNet 运行时可提交二维码，反之亦然。
- 两个轮询同时工作。
- 一个任务完成/失败不停止另一个。
- 中间可显示 interim current，最终显示合并结果。
- 早发晚回的 latest 响应不覆盖更新响应。
- 最近同步时间来自 `lastMergedAt`。
- 二维码敏感数据仍不进入缓存、URL 和 analytics。

## 架构检查

除以下例外，仓库内不得直接修改 `syncs.scores`：

- `SyncService.commitScoreDelta()`；
- 账号删除；
- 一次性迁移脚本；
- 明确审计的管理员修复服务。

CI 使用静态规则、架构测试或明确 allowlist 防止未来新增旁路写入。

## 发布顺序

1. 增加指标，预检并处理重复 sync。
2. 部署兼容字段和 `friendCode` 唯一索引。
3. 实现统一 merge/CAS，但保持 DXNet/二维码互斥。
4. 将四条写入路径全部切到统一入口。
5. 修改全部 DXNet `update_score` 为 commit-first finalization。
6. 部署 `prober_export_states`、版本 reconciliation、queue wake、Redis 用户 lease 和
   Mongo 原子 claim/fencing；保持旧自动导出路径兼容。
7. 运行并发、重复请求和故障注入测试。
8. Backend 通过 feature flag 放开跨模式互斥。
9. 部署支持双任务状态的 Frontend。
10. 小范围开启并监控 conflict、exhausted、导出顺序和 score count。
11. 全量开启后删除 `replaceLatestSync()` 和旧跨模式兼容代码。

部署顺序：Backend → Frontend。本规范不改变 sdgb-worker contract，正常情况下不需要部署
standalone sdgb-worker。

## 最终验收

以下条件全部满足才算完成：

- 四条成绩写入路径全部经过统一增量提交入口。
- `syncs.friendCode` 唯一且不再 delete/create。
- 任意 CAS 冲突都会读取最新 current 后重新 merge。
- 任意完成顺序下，最终成绩包含所有来源观察到的最佳字段。
- 普通同步不能删除谱面或降低成绩。
- 来源完成态不会早于 sync commit。
- 重复来源请求幂等。
- 自动导出不会以旧 current 覆盖新 current。
- 前端可以同时追踪 DXNet 与二维码任务。
- `/me/score-changes` 只返回 JWT 用户、指定 `musicId + chartIndex + type` 的记录，游标
  分页按 `observedAt + _id` 稳定倒序且未登录请求返回 401。
- `/me/score-history` 只返回 JWT 用户在整数 epoch `[start, end)` 时间窗内的全部谱面记录，
  不按条数截断；缺少边界、倒置边界或超过 100 天返回 400，并正确报告 `hasEarlier`。
- `/app/scores` 的成绩历史 Tab 默认缓存最近三个月并强制选择一个有记录业务日；常驻横
  向日期条只展示缓存内有成绩的日期，切换日期不发请求。“加载更多”每次只增量追加前
  一个三个月时间窗并扩展日期条。默认 06:00 换日，可合并同日同谱面记录。
- 成绩详情把每个 `score_changes` 文档显示为一条独立记录，并覆盖 loading、空历史、
  失败重试、加载更多和离线提示；桌面与 390px 移动端无横向溢出。
- 指定业务日的成绩历史导出会合并同谱面 diff，返回有效 PNG，并按每行四张卡片计算画布
  高度；E2E 必须读取 PNG 头与 IHDR 尺寸验证真实渲染结果。
- 生产指标能够发现冲突耗尽、单调性违反和异常 score count 下降。
