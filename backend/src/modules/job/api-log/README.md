# API Log 模块

该目录用于管理 Job 执行期间的 API 调用 metadata，主要用于后台排障。

## 作用

- 接收 Worker 上报的 API 调用 metadata
- 对日志字段做基础校验（url/method/statusCode/bodySize）
- 按 `jobId` 存储与查询最近调试记录
- 使用 Redis TTL 自动过期，默认 24 小时

## 文件说明

- `api-log.controller.ts`  
  对外提供 Worker 上报接口（挂在 `/api/v1/workers/dxnet/jobs/*` 路由下）。

- `api-log.service.ts`  
  提供 Redis 写入与查询能力：
  - `saveLogs(jobId, logs)`：批量写入 metadata
  - `getLogsByJobId(jobId)`：按写入顺序查询 metadata

## 接口

| 方法 | 路径                                         | 说明                         |
| ---- | -------------------------------------------- | ---------------------------- |
| POST | `/api/v1/workers/dxnet/jobs/:jobId/api-logs` | Worker 批量上报 API 调用日志 |

上报 body 结构示例：

```json
{
  "logs": [
    {
      "url": "https://example.com/api/xxx",
      "method": "GET",
      "statusCode": 200,
      "bodySize": 12345
    }
  ]
}
```

## 数据结构

每条记录包含：

- `url`
- `method`
- `statusCode`
- `bodySize`（可空）
- `createdAt`

不保存 `responseBody` / HTML raw content。Worker 侧只上报 body size。

## 清理策略

- Redis key：`debug:api:{jobId}`
- TTL：`API_DEBUG_TTL_SECONDS`，默认 24 小时
- 每个 job 最多保留 `API_DEBUG_MAX_ENTRIES` 条，默认 500 条
