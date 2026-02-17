# Job 临时缓存模块

用于在 `update_score` 阶段存储 FriendVS HTML 中间结果，支持 Worker 崩溃后的任务恢复。

## 文件结构

- `temp-cache.schema.ts` — MongoDB 实体定义（集合 `job_temp_cache`）
- `temp-cache.service.ts` — 缓存 CRUD + 定时清理
- `temp-cache.controller.ts` — HTTP API（供 Worker 调用）

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/job/:jobId/cache/:diff/:type` | 获取缓存的 HTML |
| POST | `/api/job/:jobId/cache/:diff/:type` | 写入缓存（body: `{ html: string }`） |

## 缓存生命周期

1. Worker 在解析每个难度的 FriendVS 页面后，将 HTML 写入缓存
2. 如果 Worker 中途崩溃，新 Worker 接手后可从缓存恢复，跳过已解析的难度
3. Job 完成（completed/failed/canceled）时，`JobService` 会调用 `deleteByJobId()` 清理缓存
4. 兜底机制：MongoDB TTL 索引（1 小时）+ 定时任务（每天凌晨 3 点清理 12 小时前的记录）
