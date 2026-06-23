# Job 临时缓存模块

用于在 `update_score` 阶段存储 FriendVS 解析后的中间结果，支持 Worker 崩溃后的任务恢复。

## 文件结构

- `temp-cache.service.ts` — Redis 缓存 CRUD
- `temp-cache.controller.ts` — HTTP API（供 Worker 调用）

## API

| 方法 | 路径                                                  | 说明                                          |
| ---- | ----------------------------------------------------- | --------------------------------------------- |
| GET  | `/api/v1/workers/dxnet/jobs/:jobId/cache/:diff/:type` | 获取缓存的 FriendVS songs                     |
| PUT  | `/api/v1/workers/dxnet/jobs/:jobId/cache/:diff/:type` | 写入缓存（body: `{ songs: FriendVsSong[] }`） |

## 缓存生命周期

1. Worker 在解析每个难度的 FriendVS 页面后，将 songs 写入 Redis
2. 如果 Worker 中途崩溃，新 Worker 接手后可从缓存恢复，跳过已解析的难度
3. Job 完成（completed/failed/canceled）时，`JobService` 会调用 `deleteByJobId()` 清理缓存
4. Redis TTL 兜底过期，`JOB_TEMP_CACHE_TTL_SECONDS` 默认 1 小时

Redis key：

```text
cache:job-temp:{jobId}:{diff}:{type}
```
