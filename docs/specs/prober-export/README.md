# Diving-Fish / LXNS 成绩导出规范

> 状态：Draft，目标架构

## 核心结论

```text
syncs.__v
  = 当前成绩版本

prober_export_states.providers.*.lastSuccessVersion
  = 每个查分器最后成功导出的版本

版本不一致
  = durable 自动导出信号
```

- 自动导出不再与 DXNet/二维码/Rival/FCFS source job 一一对应。
- Score commit 只 best-effort 添加稳定 per-user BullMQ wake。
- 定期 reconciliation 比较 state 与 current sync，补回丢失 delivery。
- BullMQ 是执行器，不是自动导出的事实来源。
- 同一用户所有自动/手动导出串行，不同用户可并发。
- Redis user lease 防止外部上传并发；Mongo 原子 claim/fencing 保护 state。
- Worker claim 后读取一次 execution-time latest，所有 provider 使用同一份内存快照。
- Provider 成功游标只用 `$max` 前进；失败不推进。
- `prober_export_jobs` 保存实际 attempt 与手动请求，不保存固定旧 sync 快照。
- 导出失败不得回滚 current sync 或成绩来源终态。

## 文档导航

1. [Export State、Token 与 Attempt 模型](./01-state-and-jobs.md)
2. [自动调度、多 Backend Claim 与执行恢复](./02-scheduling-and-execution.md)
3. [手动导出、Provider、API 与可观测性](./03-manual-providers-and-api.md)
4. [迁移、发布与验收](./04-migration-and-acceptance.md)

成绩 CAS 和双模式集成边界见
[成绩更新规范](../score-updates/04-export-and-parallel-ui.md)。

## 组件职责

| 组件 | 职责 |
| --- | --- |
| `syncs` | current scores、稳定 syncId、score version `__v` |
| `users` | Diving-Fish/LXNS token；token 原文只保存在用户文档 |
| `prober_export_states` | provider enable、成功游标、退避、Mongo claim |
| `prober_export_jobs` | 手动请求和实际 auto attempt 的审计/结果 |
| BullMQ | 低延迟 wake、延迟等待、有界执行并发 |
| reconciliation scanner | 定期比较 state/sync 并补投 |
| Redis user lease | 多 Backend 下串行同一用户外部上传 |
| `ProberExportMapService` | 本地 musicId 到两个平台 ID/标题的映射 |

## 最终验收摘要

- 两个 Backend replica 竞争同一用户时只有一个上传。
- 即时 wake 丢失后 scanner 能补投。
- 成功游标只增不减。
- 上传期间 score 更新后，新版本最终再次导出。
- 一个 provider 失败不影响另一个成功。
- Token 新增/替换触发完整 current，删除/失效停止重试。
- Lease/claim 丢失会中断旧请求并 fence 旧终态。
- 用户和日志不泄露 token、claim 或完整成绩 payload。
