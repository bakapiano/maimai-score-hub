# API Log 模块

该目录用于管理 Job 执行期间的 API 调用日志，主要用于后台排障与问题回放。

## 作用

- 接收 Worker 上报的 API 调用日志
- 对日志字段做基础校验（url/method/statusCode）
- 按 `jobId` 存储与查询日志
- 通过 TTL 索引自动清理历史日志（24 小时）

## 文件说明

- `api-log.controller.ts`  
  对外提供 Worker 上报接口（挂在 `/api/job/*` 路由下）。

- `api-log.schema.ts`  
  定义 `job_api_logs` 集合结构与 TTL 索引。

- `api-log.service.ts`  
  提供日志写入与查询能力：
  - `saveLogs(jobId, logs)`：批量写入日志
  - `getLogsByJobId(jobId)`：按时间顺序查询日志

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/job/:jobId/api-logs` | Worker 批量上报 API 调用日志 |

上报 body 结构示例：

```json
{
  "logs": [
    {
      "url": "https://example.com/api/xxx",
      "method": "GET",
      "statusCode": 200,
      "responseBody": "..."
    }
  ]
}
```

## 数据结构

每条日志包含：

- `jobId`
- `url`
- `method`
- `statusCode`
- `responseBody`（可空）
- `createdAt`

## 清理策略

- 在 `api-log.schema.ts` 中配置 `createdAt` TTL 索引：`24 * 60 * 60` 秒
- MongoDB 会自动清理过期文档，无需额外定时任务
