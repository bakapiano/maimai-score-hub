# 04 — 查分器导出集成与双模式并行交互

## 权威边界

查分器 state、reconciliation、BullMQ wake、多 Backend claim、Redis user lease、provider
上传和恢复的完整规范统一维护在：

- [Diving-Fish / LXNS 成绩导出规范](../prober-export/README.md)

本文只定义成绩提交与自动导出的集成契约，以及 DXNet/二维码并行时的前端行为。

## Score Commit 与自动导出

四种成绩来源使用相同契约：

```text
score CAS increments sync.__v
  -> best-effort ensureAutoExportWake(friendCode)
  -> periodic reconciliation compares export state with sync.__v
  -> BullMQ executor exports execution-time latest
```

硬性要求：

- 自动导出的 durable source of truth 是
  `prober_export_states.providers.*.lastSuccessVersion < syncs.__v`；
- queue 只是低延迟通知和执行器，enqueue 失败不得回滚 score commit；
- no-op 不增加 `__v`，也不自动唤醒；
- 不再为每个 DXNet/二维码/Rival/FCFS source 创建一份 durable 自动导出 job；
- `prober_export_jobs` 只记录实际 attempt 和手动请求；
- score finalizer 不等待外部 provider 上传。

## 并行成绩提交期间的导出语义

示例：

```text
DXNet commit     -> sync v11 -> wake
QR commit        -> sync v12 -> wake/deduped
export executor  -> claim 后读取 current v12 -> 上传 v12
```

如果 executor 已经读取 v11 后 QR 才提交 v12：

1. 本次 attempt 记录成功导出的 v11；
2. export state 游标推进到 v11；
3. scanner 继续看到 `v11 < v12`；
4. 下一次 attempt 导出 v12。

因此 score commit 不依赖导出顺序，导出也不会阻塞 CAS。

## 放开 Backend 跨模式互斥

只有统一 merge/CAS、commit-first 和新导出状态机全部通过测试后，才能移除跨模式互斥。

- 二维码创建只阻止已有 `get_music_score` 或 cleanup pending/unconfirmed；
- DXNet 创建不再调用 `assertNoActiveCabinetJob()`；
- 创建期 mutex 按模式区分，或只保留同模式防重复；
- QR session cleanup 安全门槛保持不变；
- sdgb cleanup 继续高于普通 Interactive 调用。

## Frontend 状态拆分

`SyncPage` 从一个全局 `syncing` 改成：

- `dxnetJobId/dxnetStatus/dxnetActive/dxnetError`；
- `cabinetJobId/cabinetStatus/cabinetActive/cabinetError`。

要求：

- 两个轮询不得依赖当前 `syncMethod`；
- 初始化两个 active 查询分别使用 `if`，不得 `else if`；
- 一个任务完成/失败不得停止另一个轮询；
- 模式选择只控制输入面板，同模式 active 才禁用提交；
- 两个任务都完成后强制读取 current；
- latest 请求使用请求序号，早发晚回不得覆盖更新结果；
- “最近同步”使用 `lastMergedAt`；
- 二维码不得进入 URL、localStorage、IndexedDB、analytics 或离线缓存。

中间一个任务完成时可以显示 interim current；另一个完成后必须显示包含两者 delta 的最终
current。自动导出状态从 `prober_export_states` 的安全投影读取，不再依赖
`syncs.autoExportResult`。
