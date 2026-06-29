# 目标架构

目标是把 log、trace、metric、alert 分层，避免所有 debug 数据都走各自 API 流入 Mongo。

## 数据分类

| 类型 | 例子 | 保留期 | 存储 |
| --- | --- | --- | --- |
| Business state | `jobs`、`sdgb_jobs`、`auto_update_runs`、`bot_statuses` | 1d / 7d / 30d / 永久，按业务定 | MongoDB |
| Debug trace | 单个 job 的外部 API 调用序列 | 24h，按 job 限长 | Redis JSON/List |
| Console tail | worker stdout/stderr 最近日志 | 最近 N 条或数小时 | Redis Stream |
| Metrics | QPS、成功率、错误率、latency、queue lag、567 次数 | 聚合桶 30-90d | Redis buffer -> MongoDB |
| Alert state | 规则、订阅、触发记录、静默状态 | 30-180d | MongoDB |
| Debug artifact | 可选 HTML/JSON 响应体 gzip | 24h，按大小 cap | 本地 volume，后续可换对象存储 |

## ObservabilityModule

新增 backend 模块：

```text
backend/src/modules/observability
  observability.module.ts
  services/
    log-tail.service.ts
    job-trace.service.ts
    metric-buffer.service.ts
    metric-bucket-writer.service.ts
    alert-evaluator.service.ts
    artifact.service.ts
  schemas/
    monitor-metric-bucket.schema.ts
    monitor-alert-rule.schema.ts
    monitor-alert-event.schema.ts
```

统一提供内部接口：

```ts
recordLog(entry)
recordJobTrace(jobId, traceEntry)
incrementMetric(name, dimensions, value = 1)
observeMetric(name, dimensions, value)
recordAlertEvent(event)
saveArtifact(input)
```

旧 controller 可以先保留路径，但内部只调用 ObservabilityModule。这样前端和 worker API 不必一次性大改。

## Redis key 设计

| Key | 类型 | 用途 |
| --- | --- | --- |
| `maimai:logs:worker:dxnet` | Stream | DXNet worker 最近日志 |
| `maimai:logs:worker:sdgb` | Stream | sdgb-worker 最近日志 |
| `maimai:debug:api:{jobId}` | JSON/List | 单 job API trace，TTL 24h |
| `maimai:metrics:buffer:{bucketStart}:{metric}:{dimHash}` | Hash | 当前 bucket 计数/耗时 buffer，TTL 2d |
| `maimai:status:worker:{kind}:{workerId}` | JSON | worker 心跳、最近日志时间、处理计数，短 TTL |

Redis 只保存短期和可丢弃数据。Mongo 仍保存业务事实和聚合后指标。

## Mongo 新集合

### `monitor_metric_buckets`

用于看板历史趋势，不保存 raw log。

```ts
{
  bucketStart: Date;
  bucketSizeSec: number;       // 60 / 300 / 3600
  metric: string;              // e.g. sdgb.rival.count
  dimensionsHash: string;      // stable hash of dimensions
  dimensions: Record<string, string>;
  count: number;
  sum: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  updatedAt: Date;
}
```

索引：

- unique `{ metric: 1, bucketStart: 1, bucketSizeSec: 1, dimensionsHash: 1 }`
- `{ metric: 1, bucketStart: -1 }`
- `{ bucketStart: 1 }` TTL 90d

写入方式：

1. 服务代码只写 Redis buffer，避免每个事件都打 Mongo。
2. backend 定时 flush 最近 bucket 到 Mongo，用 `$inc` / `$min` / `$max`。
3. admin 看板只查 Mongo 聚合桶和少量 Redis current-state。

### `monitor_alert_rules`

```ts
{
  id: string;
  name: string;
  enabled: boolean;
  severity: "info" | "warning" | "critical";
  source: "metric" | "state";
  metric?: string;
  dimensions?: Record<string, string>;
  windowSec: number;
  comparator: ">" | ">=" | "<" | "<=" | "==" | "!=";
  threshold: number;
  forSec: number;              // condition must hold for this long
  cooldownSec: number;
  channels: string[];          // feishu/webhook/email etc.
  createdAt: Date;
  updatedAt: Date;
}
```

### `monitor_alert_events`

记录触发、恢复、静默：

```ts
{
  id: string;
  ruleId: string;
  status: "firing" | "resolved" | "silenced";
  severity: string;
  message: string;
  value: number | null;
  startedAt: Date;
  resolvedAt: Date | null;
  lastNotifiedAt: Date | null;
}
```

TTL 可设 180d。

## API 分层

对外路径可以保持兼容，但语义统一：

| API | 说明 |
| --- | --- |
| `POST /workers/logs/:kind/batches` | worker console tail，写 Redis Stream |
| `POST /workers/dxnet/jobs/:jobId/api-logs` | job API trace metadata，写 Redis |
| `GET /admin/worker-logs` | 读 Redis Stream 最近 tail |
| `GET /admin/dxnet-jobs/:jobId/api-logs` | 读 Redis job trace |
| `GET /admin/monitor/overview` | 读业务状态 + metric buckets |
| `GET /admin/monitor/metrics` | 通用 metric 查询 |
| `GET /admin/monitor/storage` | Mongo/Redis 存储与 TTL 状态 |
| `GET/POST/PATCH /admin/alerts/rules` | alert rule 管理 |
| `GET/POST/PATCH /admin/alerts/subscriptions` | 订阅管理 |

## 指标从哪里来

### 直接业务事件

在代码路径上直接打点，不从日志文本反推：

| 指标 | 打点位置 |
| --- | --- |
| `dxnet.job.created/completed/failed` | `JobService.create()` / PATCH 完成路径 |
| `dxnet.api.status` | worker HTTP client 上报 API trace 时顺带计数 |
| `dxnet.rate_limit.567` | worker 识别状态码或错误分类后上报 |
| `sdgb.job.created/completed/failed` | `SdgbJobService` |
| `sdgb.api.latency_ms` | sdgb-worker patch result 或专门 metrics endpoint |
| `auto_update.rival.changed/no_change/failed` | auto update scheduler |
| `auto_update.queue_lag_ms` | due time 到开始处理的差值 |
| `prober_export.completed/failed` | prober export worker |

### 当前状态快照

从业务表或 Redis current-state 读取：

- active jobs / queue depth
- bot available / lastReportedAt / friendCount
- sdgb-worker heartbeat / claimed count
- Mongo collection stats
- Redis memory / stream length

## 安全和隐私边界

- 默认不保存 raw response body。
- debug artifact 必须有 TTL、大小 cap 和显式开关。
- metric dimensions 避免无限 cardinality；`friendCode`、`jobId` 不进入常规 metric dimensions，只作为 trace 查询字段。
- admin API 继续走 shared secret / admin guard。
- worker 上报只允许 shared secret，不把 Redis 端口暴露给 worker。

