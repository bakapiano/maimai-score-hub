# Breaking Migration Plan

目标：切到 ClickHouse 历史观测仓库 + Redis 运行态 + artifact raw body 的模型，重做 admin portal 指标口径。

迁移策略是旁路上线：新观测链路先写入 ClickHouse / artifact，验证后逐页替换 admin portal。旧 admin 页面可以与新页面并存一段时间；新系统不依赖旧 Mongo debug 数据。

## Phase 0: 101 Dev / PoC

### 0.1 部署 ClickHouse 和 artifact service

按 [clickhouse-single-node.md](./clickhouse-single-node.md) 和 [raw-response-artifacts.md](./raw-response-artifacts.md) 在 101 上部署：

- ClickHouse single node。
- artifact service。
- `/srv/maimai-observability/artifacts`。

prod/dev 共用同一套服务，但必须用 `environment` 隔离。详见 [dev-testing.md](./dev-testing.md)。

### 0.2 建表

按 [clickhouse-schema.md](./clickhouse-schema.md) 建：

- `http_requests`
- `frontend_rum`
- `analytics_events`
- `structured_logs`
- `external_api_calls`
- `job_timeline_events`
- materialized views

### 0.3 本地验证

本地 Windows dev 连接 101：

- local backend 写 `environment='dev'` 的 `http_requests`。
- local frontend 写 `frontend_rum` / `analytics_events`。
- local worker 或 mock 写 `external_api_calls`。
- error response / debug capture 写 `raw-response/dev/...` artifact。

验证通过后再接 prod 写入。

## Phase 1: Backend / Worker 旁路写入

### 1.1 backend ClickHouse client

新增 `ClickHouseService`：

- 批量 insert。
- 1-5 秒 flush。
- 每表单独 buffer。
- 写入失败计数。
- 可选 Redis capped buffer。

业务主链路不能依赖 ClickHouse 成功。ClickHouse 不可用时降级为丢弃 observability events + alert。

### 1.2 backend HTTP interceptor

新增全局 interceptor 写 `http_requests`：

- `environment`
- route template。
- method。
- statusCode。
- durationMs。
- responseBytes。
- friendCode。
- traceId/requestId。

这一步先旁路写入，admin 页面后续逐页切换。

### 1.3 structured logger

backend / worker / sdgb-worker 统一 JSON log：

- environment。
- service。
- instance。
- level。
- message。
- traceId。
- jobId。
- workerId。
- eventName。
- errorClass。

写 `structured_logs`。console 仍输出，便于 docker logs。当前实现不单独建
`worker_events` 表；worker 生命周期、job picked/completed/failed 等排障事件
统一通过 `structured_logs` 和 `job_timeline_events` 表达，避免多一套未生产的
事件表。

### 1.4 external API calls

新增 external API metadata 上报：

- worker 每个外部调用上报 metadata。
- body 不上报；error/debug/采样成功时保存 artifact 后只上报 `artifactKey`。
- raw response 保存规则见 [raw-response-artifacts.md](./raw-response-artifacts.md)。

新 Job Debug 后续改查 ClickHouse `external_api_calls`。

### 1.5 job timeline

在 `JobService`、worker PATCH、`SdgbJobService` 关键状态变更处写 `job_timeline_events`：

- created。
- queued。
- picked。
- stage_changed。
- delayed。
- completed。
- failed。
- canceled。

## Phase 2: Frontend RUM / Analytics

### 2.1 RUM SDK

前端采集：

- environment。
- route。
- FCP / LCP / INP / CLS / TTFB / loadMs。
- JS error。
- frontend fetch duration。
- sessionId / friendCode。

批量上报 `/api/v1/observability/rum`。

### 2.2 Product analytics

先埋最小事件集：

- `page_view`
- `login_success`
- `sync_started`
- `sync_completed`
- `sync_failed`
- `cabinet_bind_started`
- `cabinet_bind_completed`
- `export_started`
- `export_completed`
- `auto_update_enabled`
- `auto_update_disabled`

DAU 从 `analytics_events` 计算，不从 token 或 Mongo user update 猜。

## Phase 3: Admin Portal 逐页替换

### 3.1 新增 Realtime

页面：

- System Health。
- Worker & Bot。
- Queue & Backlog。
- Recent Errors。
- Recent Usage / Upstream Pressure。

数据：

- Mongo current state。
- Redis runtime state。
- ClickHouse 最近 5-15 分钟。

### 3.2 新增 History

页面：

- Product Analytics。
- Backend API。
- Frontend RUM。
- DXNet Worker。
- SDGB / Auto Update。
- Logs。

数据全部来自 ClickHouse，并且必须带 environment selector，默认 `prod`。

### 3.3 新 Job Debug

`GET /admin/jobs/:jobId/debug` 返回聚合视图：

```ts
{
  job,
  timeline,
  externalApiCalls,
  logs,
  artifacts
}
```

Mongo + ClickHouse + artifact 组合查询。

### 3.4 废弃旧页面

新页面稳定后，再废弃或删除旧页面：

- 依赖 `worker_logs` grep 的 567 指标。
- 依赖 `job_api_logs.responseBody` 的 API debug。
- 用 `jobs` 临时聚合出来的伪 API latency。
- 无明确口径的“实时统计”卡片。

旧页面可与新页面并存一段时间，等新页面口径稳定后再移除。

## Phase 4: Alert

### 4.1 Mongo alert config

新增：

- `alert_rules`
- `alert_subscriptions`
- `alert_events`

### 4.2 evaluator

backend cron 每 30s：

- realtime 规则读 Mongo/Redis。
- historical 规则查 ClickHouse。
- firing/resolved 写 Mongo。
- 通知飞书/webhook。

### 4.3 初始规则

见 [dashboards-alerts.md](./dashboards-alerts.md)。

## 回滚策略

ClickHouse 是旁路系统，回滚不应影响业务：

- ClickHouse down：停止写观测数据，业务继续。
- frontend RUM down：丢弃事件。
- external API metadata down：job 仍执行。
- artifact service down：`artifactKey = null`，metadata 仍可写。
- admin History 不可用：Realtime 仍可从 Mongo/Redis 看当前状态。

回滚时只关闭新观测写入或隐藏新页面，不影响业务主链路。

## 验证清单

PoC：

- ClickHouse `/ping` ok。
- artifact service `/health` ok。
- 建表和 MV 成功。
- dev environment 有 `http_requests` / `frontend_rum` / `analytics_events` / `external_api_calls`。
- dev artifact 写到 `raw-response/dev/...`。

prod 旁路写入：

- prod environment 有 backend `http_requests`。
- prod worker 有 `external_api_calls`。
- prod frontend 有 `frontend_rum`。
- `analytics_events` 能算 DAU。
- job debug 能按 environment + jobId 查 timeline / external calls / logs。
- artifact 保存和 TTL 清理可用。

admin 切换：

- Realtime 页面口径可解释。
- History 页面默认查 prod，可切 dev。
- 旧 admin 指标页面有明确废弃计划。
