# 迁移计划

目标是先止血，再统一模型，最后做 alert。

## Phase 0: 线上止血

### 0.1 停止保存 raw response body

改 worker API log 上报：

```ts
{
  url,
  method,
  statusCode,
  durationMs,
  bodySize,
  bodyHash?,
  errorClass?
}
```

后端不再接受或持久化 `responseBody`。如果 shared contract 暂时兼容旧字段，也必须在后端丢弃。

### 0.2 修复 TTL index 漂移

线上实际没有 TTL：

- `worker_logs.ts_1`
- `job_api_logs.createdAt_1`

处理方式二选一：

1. 直接 drop debug collections：如果确认不需要历史 debug 内容，这是最干净的。
2. drop 普通 index 后重建 TTL index：适合想保留最近窗口的情况。

注意：不能只改 Mongoose schema 后等待自动同步。已有普通 index 不会自动变成 TTL index。

### 0.3 加 Redis 基础设施

在 Server 5 backend compose 增加 Redis：

- `redis:7-alpine`
- `appendonly yes`
- `appendfsync everysec`
- `maxmemory 512mb`
- `maxmemory-policy noeviction`
- password required

初期只有 backend 访问 Redis；worker 不直连 Redis，仍通过 backend HTTP 上报。

## Phase 1: 写入路径切换

### 1.1 引入 ObservabilityModule

新增统一 facade：

- `recordLog`
- `recordJobTrace`
- `incrementMetric`
- `observeMetric`

旧 controller 保持兼容：

- `POST /workers/logs/:kind/batches`
- `POST /workers/dxnet/jobs/:jobId/api-logs`
- `GET /admin/worker-logs`
- `GET /admin/dxnet-jobs/:jobId/api-logs`

但内部不再写 Mongo debug collection。

### 1.2 Worker logs 写 Redis Stream

建议初始配置：

```text
WORKER_LOG_STREAM_MAXLEN=100000
WORKER_LOG_STREAM_MAX_SCAN=20000
```

按当前 24h 约 25 万行，100k 大致覆盖数小时到半天窗口；如果 Redis 512MB 压力低，再上调。

### 1.3 Job API trace 写 Redis

建议配置：

```text
API_DEBUG_TTL_SECONDS=86400
API_DEBUG_MAX_ENTRIES=500
```

只保存 metadata，不保存 body。

## Phase 2: 看板指标化

### 2.1 建 `monitor_metric_buckets`

用 1m / 5m / 1h bucket 支撑看板。

初始指标：

- `dxnet.job.created`
- `dxnet.job.completed`
- `dxnet.job.failed`
- `dxnet.api.status`
- `dxnet.rate_limit.567`
- `sdgb.job.completed`
- `sdgb.job.failed`
- `auto_update.rival.changed`
- `auto_update.rival.no_change`
- `auto_update.rival.failed`
- `auto_update.queue_lag_ms`
- `prober_export.completed`
- `prober_export.failed`

### 2.2 替换日志 grep 指标

`AdminService.getAutoUpdateMetrics()` 中的 567 统计从 `worker_logs` grep 切换为 `dxnet.rate_limit.567` metric bucket。

保留日志 tail 只作为 debug，不作为 dashboard source of truth。

### 2.3 Storage audit

新增 admin storage endpoint：

- collection stats
- TTL index audit
- Redis stream length
- Redis memory

这个 endpoint 是防止 debug 数据再次膨胀的看板基础。

## Phase 3: Alert 订阅

### 3.1 先内建轻量 rule evaluator

backend cron 每 30s 评估：

- Redis health
- worker heartbeat
- bot availability
- Mongo memory/disk
- 业务错误率
- queue lag

规则和事件存在 Mongo。

### 3.2 接通知渠道

先支持：

- webhook
- 飞书机器人

通知必须带 admin deep link 和最近窗口摘要，不带 raw body。

### 3.3 后续外接 Prometheus/Alertmanager

当需要更多基础设施指标和成熟 silence/routing 时，再接：

- Prometheus scrape backend `/metrics`
- node-exporter / cAdvisor
- Alertmanager

当前阶段不把它作为前置依赖。

## 验证清单

上线前：

- `npm run build` in `shared`
- `npm run build` in `backend`
- `npm run build` in `frontend`
- worker API log 上报不再包含 `responseBody`
- Redis down 时 backend 明确 fail fast 或降级；不要静默写回 Mongo raw logs
- admin worker logs 页面能读 Redis Stream
- job debug 页面能显示 Redis API trace metadata
- storage audit 能发现 TTL index 是否缺失

上线后：

- `worker_logs` Mongo 不再增长。
- `job_api_logs` Mongo 不再增长。
- Redis stream length 受 `MAXLEN` 控制。
- Mongo memory 不因 debug 页面查询出现明显抖动。
- 24h 后检查 `monitor_metric_buckets` bucket 数量和索引大小。

## 回滚策略

- Phase 1 保留旧 GET API 响应 shape，前端可不回滚。
- 如果 Redis 出问题，短期可以关闭 worker log ingest，保留业务主链路；不要回滚到 Mongo raw body。
- API trace 可以临时只返回空数组，job debug 仍能看 `jobs` raw JSON。
- 业务表和队列不依赖 debug storage，因此 log/monitor 回滚不应影响用户同步和自动更新。

