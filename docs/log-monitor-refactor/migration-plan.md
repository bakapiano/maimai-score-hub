# Breaking Migration Plan

目标：直接切到 ClickHouse 历史观测仓库 + Redis 运行态 + artifact raw body 的模型，重做 admin portal 指标口径。

## Phase 0: 线上止血

### 0.1 停止 raw response body 入 Mongo

立刻改 worker API log 上报和后端接收：

```ts
{
  urlGroup,
  method,
  statusCode,
  durationMs,
  bodySize,
  bodyHash?,
  errorClass?,
  artifactKey?
}
```

后端丢弃 `responseBody`。即使 shared contract 暂时兼容旧字段，也不再持久化。

### 0.2 清理旧 debug collections

线上实际没有 TTL：

- `worker_logs.ts_1`
- `job_api_logs.createdAt_1`

由于方案 breaking change，建议：

1. 备份必要样本。
2. drop `worker_logs`。
3. drop `job_api_logs`。
4. 移除相关 Mongoose schema / model 注册，避免继续写入。

如果短期不敢 drop，至少 rename 到 `*_legacy_20260629`，并阻断新写入。

### 0.3 保留 Mongo 业务表

不动：

- `jobs`
- `sdgb_jobs`
- `syncs`
- `userentities`
- `bot_statuses`
- `auto_update_*`

这些仍是业务 source of truth。

## Phase 1: ClickHouse 单体上线

### 1.1 部署 ClickHouse

按 [clickhouse-single-node.md](./clickhouse-single-node.md) 部署单体。

要求：

- 不放 Server 5。
- 不公网暴露。
- 固定版本。
- 单独数据 volume。
- 创建写入用户和只读查询用户。

### 1.2 建表

按 [clickhouse-schema.md](./clickhouse-schema.md) 建：

- `http_requests`
- `frontend_rum`
- `analytics_events`
- `structured_logs`
- `external_api_calls`
- `worker_events`
- `job_timeline_events`
- materialized views

### 1.3 backend ClickHouse client

新增 `ClickHouseService`：

- 批量 insert。
- 1-5 秒 flush。
- 每表单独 buffer。
- 写入失败计数。
- 可选 Redis capped buffer。

业务主链路不能依赖 ClickHouse 成功。ClickHouse 不可用时降级为丢弃 observability events + alert。

## Phase 2: 后端和 worker 埋点

### 2.1 backend HTTP interceptor

新增全局 interceptor 写 `http_requests`：

- route template。
- method。
- statusCode。
- durationMs。
- responseBytes。
- friendCode。
- traceId/requestId。

替换 admin 里基于 `jobs` 粗算 API 访问量/latency 的页面。

### 2.2 structured logger

backend / worker / sdgb-worker 统一 JSON log：

- service。
- instance。
- level。
- message。
- traceId。
- jobId。
- workerId。
- eventName。
- errorClass。

写 `structured_logs`。console 仍输出，便于 docker logs。

### 2.3 external API calls

替换 `job_api_logs`：

- worker 每个外部调用上报 metadata。
- body 不上报；error/debug 时保存 artifact 后只上报 `artifactKey`。
- admin job debug 从 ClickHouse 查 `external_api_calls`。

### 2.4 job timeline

在 `JobService`、worker PATCH、`SdgbJobService` 关键状态变更处写 `job_timeline_events`：

- created。
- queued。
- picked。
- stage_changed。
- delayed。
- completed。
- failed。
- canceled。

## Phase 3: frontend RUM / analytics

### 3.1 RUM SDK

前端采集：

- route。
- FCP / LCP / INP / CLS / TTFB / loadMs。
- JS error。
- frontend fetch duration。
- sessionId / friendCode。

批量上报 `/api/v1/observability/rum`。

### 3.2 Product analytics

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

## Phase 4: admin portal breaking redesign

### 4.1 删除旧指标页面

删除或重写：

- 依赖 `worker_logs` grep 的 567 指标。
- 依赖 `job_api_logs.responseBody` 的 API debug。
- 用 `jobs` 临时聚合出来的伪 API latency。
- 无明确口径的“实时统计”卡片。

### 4.2 新增 Realtime

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

### 4.3 新增 History

页面：

- Product Analytics。
- Backend API。
- Frontend RUM。
- DXNet Worker。
- SDGB / Auto Update。
- Logs。

数据全部来自 ClickHouse。

### 4.4 新 Job Debug

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

## Phase 5: Alert

### 5.1 Mongo alert config

新增：

- `alert_rules`
- `alert_subscriptions`
- `alert_events`

### 5.2 evaluator

backend cron 每 30s：

- realtime 规则读 Mongo/Redis。
- historical 规则查 ClickHouse。
- firing/resolved 写 Mongo。
- 通知飞书/webhook。

### 5.3 初始规则

见 [dashboards-alerts.md](./dashboards-alerts.md)。

## 回滚策略

ClickHouse 是旁路系统，回滚不应影响业务：

- ClickHouse down：停止写观测数据，业务继续。
- frontend RUM down：丢弃事件。
- external API metadata down：job 仍执行。
- admin History 不可用：Realtime 仍可从 Mongo/Redis 看当前状态。

不能回滚到：

- raw `responseBody` 写 Mongo。
- worker_logs 写 Mongo。

如果确实需要临时排障，开启 artifact capture，而不是恢复旧入库路径。

## 验证清单

上线前：

- ClickHouse `/ping` ok。
- 建表和 MV 成功。
- backend `http_requests` 有数据。
- worker `external_api_calls` 有数据。
- frontend `frontend_rum` 有数据。
- `analytics_events` 能算 DAU。
- job debug 能按 jobId 查 timeline / external calls / logs。
- artifact 保存和 TTL 清理可用。

上线后 24h：

- Mongo `worker_logs` / `job_api_logs` 不再增长。
- ClickHouse 各表 rows 增长符合预期。
- ClickHouse disk 增长在预估范围内。
- admin Realtime 和 History 页面口径可解释。
- 旧 admin 指标页面移除或标记废弃。
