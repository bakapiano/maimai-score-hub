# 目标架构

目标是把实时状态、历史分析、排障日志和 raw artifact 分层，避免所有 admin debug 数据都走各自 API 流入 Mongo。

## 总体分层

| 层 | 负责 | 存储 |
| --- | --- | --- |
| Business source of truth | 用户、成绩、job 状态、bot 状态、自动更新状态 | MongoDB |
| Runtime state | 队列、限流、锁、worker heartbeat、短期 cache | Redis |
| Historical observability | API/RUM/analytics/logs/external calls/job events | ClickHouse |
| Artifact | raw HTML、large JSON、debug dump | 本地 volume，后续对象存储 |
| Alert config | 规则、订阅、silence、通知状态 | MongoDB |

## ObservabilityModule 当前实现

新增 backend 模块：

```text
backend/src/modules/observability
  observability.module.ts
  services/
    clickhouse.service.ts
    observability-ingest.service.ts
    observability-query.service.ts
    observability-env.ts
  interceptors/
    http-observability.interceptor.ts

backend/src/api/observability
  observability.controller.ts

backend/src/api/admin
  admin-observability.controller.ts
```

内部接口：

```ts
recordHttpRequest(event)
recordFrontendRum(event)
recordAnalyticsEvent(event)
recordStructuredLog(event)
recordExternalApiCall(event)
recordJobTimelineEvent(event)
```

当前没有单独的 `worker_events` 表；worker 生命周期、job picked/completed/failed 等排障上下文通过 `structured_logs` 和 `job_timeline_events` 表达。artifact service 已部署在 101，但自动 raw response capture 尚未接入 backend/worker。

## 写入路径

### backend HTTP request

Nest 全局 interceptor 记录：

- `method`
- route template，例如 `/api/v1/me/dxnet-jobs/:jobId`
- `statusCode`
- `durationMs`
- `requestBytes` / `responseBytes`
- `friendCode`，如果有登录用户
- `traceId` / `requestId`

真实 URL 不作为聚合维度，避免 `jobId`、query string 造成高基数。

### frontend RUM

前端采集：

- route。
- FCP / LCP / INP / CLS / TTFB / page load。
- JS error。
- API fetch duration，可关联 `traceId`。
- sessionId、friendCode。

通过 `POST /api/v1/observability/rum` 批量上报。

### analytics event

前端和后端共同上报产品事件：

- `page_view`
- `login_success`
- `sync_started`
- `sync_completed`
- `cabinet_bind_started`
- `cabinet_bind_completed`
- `export_started`
- `export_completed`
- `auto_update_enabled`

用于 DAU、功能使用、转化和留存。

### worker structured logs

worker 不再上报自由文本到 Mongo。统一为：

```ts
{
  ts,
  service: "dxnet-worker" | "sdgb-worker",
  instance,
  level,
  message,
  traceId?,
  jobId?,
  workerId?,
  botFriendCode?,
  eventName?,
  attrs?
}
```

ClickHouse 保存历史日志。admin live tail 也优先查 ClickHouse 最近 15 分钟。

### external API calls

DXNet worker / sdgb-worker 上报 metadata：

```ts
{
  ts,
  jobId,
  workerId,
  botFriendCode,
  target: "maimai_dxnet" | "sdgb" | "diving_fish" | "lxns",
  apiGroup,
  method,
  urlGroup,
  statusCode,
  durationMs,
  bodySize,
  bodyHash?,
  artifactKey?,
  errorClass?
}
```

不保存 raw body。raw body 只进 artifact。

### job timeline

用结构化事件替代“看 raw job JSON 猜发生了什么”：

- `created`
- `queued`
- `picked`
- `stage_changed`
- `delayed`
- `completed`
- `failed`
- `canceled`
- `retry_scheduled`

job 当前状态仍在 Mongo，timeline 进 ClickHouse。

## 查询路径

### 实时监控

admin 首页实时区只读：

- Mongo：`bot_statuses`、active jobs、auto update due state。
- Redis：worker heartbeat、BullMQ queue summary、rate-limit 状态、ClickHouse ingest buffer backlog。
- ClickHouse：最近 5-15 分钟错误和 latency，用于趋势小图。

### 历史分析

admin 历史 tab 和 Grafana 查 ClickHouse：

- DAU。
- API QPS、latency、error rate。
- frontend route performance。
- worker / sdgb throughput。
- external API success rate。
- upstream usage / pressure trend。

### Job Debug

点开 job 时组合：

1. Mongo `jobs` / `sdgb_jobs`：当前业务状态。
2. ClickHouse `job_timeline_events`：状态流转。
3. ClickHouse `external_api_calls`：外部 API trace。
4. ClickHouse `structured_logs`：相关日志。
5. artifact：可选 raw HTML。

## API 分层

breaking change 后推荐路径：

| API | 用途 |
| --- | --- |
| `POST /observability/rum` | frontend RUM 批量上报 |
| `POST /observability/events` | analytics event 批量上报 |
| `POST /workers/logs/:kind/batches` | worker structured logs 批量上报 |
| `POST /workers/dxnet/jobs/:jobId/api-calls` | external API metadata 批量上报 |
| `POST /workers/:kind/external-api-calls` | 通用 worker external API metadata 批量上报，供 sdgb-worker 等服务接入 |
| `GET /admin/realtime/overview` | 实时状态总览 |
| `GET /admin/realtime/workers` | worker / bot / queue 当前状态 |
| `GET /admin/history/api` | API 历史统计 |
| `GET /admin/history/rum` | 前端性能历史 |
| `GET /admin/history/analytics` | DAU / 产品事件 |
| `GET /admin/history/workers` | worker / sdgb 历史统计 |
| `GET /admin/jobs/:jobId/debug` | job 组合调试视图 |
| `GET/POST/PATCH /admin/alerts/*` | alert 管理 |

## 安全和基数控制

- prod/dev 共用 101 ClickHouse 时，所有明细表、聚合表、admin 查询和 artifact key 都必须带 `environment`。
- `friendCode` 和 `botFriendCode` 明文进入 ClickHouse，便于 admin 排障。
- Mongo `_id` 默认不进入 ClickHouse。
- token、cookie、secret、raw QR、raw body 禁止进入 ClickHouse。
- route 必须是模板，不存无限路径。
- `jobId` 可以作为排障字段，但不要作为常规聚合维度。
- raw body 不进 ClickHouse。
- logs `attrs` 限制大小，例如 4KB。
- 前端 RUM 采样率可配，初始 100%，后续按流量下调。
