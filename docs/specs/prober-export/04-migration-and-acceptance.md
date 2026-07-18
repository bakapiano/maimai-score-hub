# 04 — 迁移、发布与验收

## 迁移顺序

1. 新增 `prober_export_states` schema/index 和 token 双写逻辑。
2. 为现有 token 用户回填 state；初始成功游标设为 null，允许一次完整重导。
3. 扩展 `prober_export_jobs` 为 attempt 语义和 requested/exported version。
4. 实现 reconciliation、稳定 wake、Redis user lease、Mongo claim/fencing。
5. 修改 provider client 支持 AbortSignal。
6. 手动导出切到新 executor。
7. 四种 score commit 改成 best-effort per-user wake。
8. 双写观察期保留旧 source-job 路径，但只允许新旧一边执行外部上传。
9. Version lag 收敛后移除旧 trigger、exact-sync 查询和 sync result mirror。
10. 更新 Admin metrics 和用户状态展示。

## 回滚原则

- 不回滚已经提交的 current sync。
- 新 state 表可保留，停止 scanner/wake 即停止新自动 attempt。
- 回滚期间必须防止新旧 executor 同时上传同一用户。
- Manual API 回滚前先排空 active claim，避免旧 worker 越权写 state。
- Token 原文始终保留在 user 文档，不因 state 回滚迁移。

## 验收

- 两个 Backend replica 同时处理同一用户时只有一个获得 claim 并上传。
- 同一用户自动/手动不并发，不同用户可并发。
- 即时 wake 丢失后 scanner 能补投。
- Provider 游标只增不减。
- Provider 结果/游标与 claim release 通过同一 token-fenced state update 原子发布。
- 上传期间 score 更新后，新版本最终再次导出。
- 一个 provider 失败不影响另一个成功游标。
- Token 新增/替换触发完整 current，删除/失效停止重试。
- Lease/claim 丢失会中断旧请求并 fence 旧终态。
- 导出失败不影响 current sync 或成绩来源终态。
- 用户和日志不泄露 token、claim 或完整成绩 payload。
