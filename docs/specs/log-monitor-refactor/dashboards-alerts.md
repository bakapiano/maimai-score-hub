# Dashboard 与 Alert 订阅

admin portal 需要把“实时监控”和“历史分析”分开。现有页面里很多指标是临时从 `jobs` 或 `worker_logs` 拼出来的，重构后它们应改成有明确数据源和口径。

## Realtime Dashboard

目标：打开 admin 第一屏就能判断当前系统是否健康。

刷新频率：5-15 秒。

数据源：Mongo current state + Redis runtime state + ClickHouse 最近 5-15 分钟窗口。

### 1. System Health

卡片：

- backend healthy replicas。
- Mongo memory / disk / query timeout。
- Redis memory / BullMQ health。
- ClickHouse ping / disk free / insert lag。
- artifact volume usage。

告警优先级：

- backend healthy replicas < 2。
- Mongo memory > 90% cap。
- ClickHouse disk free < 20GB。
- ClickHouse insert lag > 60s。

### 2. Worker & Bot

表格：

- workerKind。
- workerId。
- lastHeartbeatAt。
- heartbeatAge。
- currentJobId。
- processed last 5m / 1h。
- error last 5m / 1h。

Bot 表：

- friendCode。
- remark。
- available。
- lastReportedAt。
- friendCount。
- cabinetUserId exists。
- active job count。

### 3. Queue & Backlog

指标：

- DXNet queued / processing / delayed。
- sdgb queued / processing。
- oldest queued age。
- auto update rival due backlog。
- map due backlog。
- FC/FS enrichment due backlog。

### 4. Recent Errors

ClickHouse 最近窗口：

- backend 5xx。
- frontend JS error。
- DXNet external API error。
- DXNet 567。
- sdgb failed。
- prober export failed。

### 5. Recent Usage / Upstream Pressure

外部 call 现在不收费，因此这里不展示“费用”，只展示调用量和上游压力：

- today total external API calls。
- today `sdgb.get_rival_music` calls。
- today `sdgb.get_user_map` calls。
- today DXNet friend page calls。
- today prober export calls。
- 每小时调用趋势。
- DXNet 567 / 空响应趋势。
- external API p95 latency。

## History Dashboard

目标：回答历史趋势、性能、产品行为。

默认窗口：24h / 7d / 30d。

数据源：ClickHouse。

prod/dev 共用 ClickHouse 时，History 页面必须提供 environment selector；默认 `prod`，开发排查时显式切到 `dev`。

### 1. Product Analytics

图表：

- site DAU / WAU / MAU。
- sync DAU。
- login DAU。
- page view by route。
- sync started/completed/failed funnel。
- cabinet bind started/completed funnel。
- export started/completed by provider。
- auto update enabled users trend。

### 2. Backend API

图表：

- requests by route。
- p50/p95/p99 duration by route。
- 4xx / 5xx error rate by route。
- slowest routes。
- top error routes。
- response bytes by route。

表格：

- routeTemplate。
- requests。
- p50 / p95 / p99。
- 4xx。
- 5xx。
- error rate。

### 3. Frontend RUM

图表：

- LCP p75/p95 by route。
- INP p75/p95 by route。
- CLS p75/p95 by route。
- loadMs p95 by route。
- JS error count/rate。
- API wait time from frontend perspective。

表格：

- routeTemplate。
- samples。
- LCP p75。
- INP p75。
- load p95。
- JS errors。

### 4. DXNet Worker

图表：

- jobs completed/failed by jobType。
- job duration p95 by jobType。
- external API calls by urlGroup。
- external API p95 by urlGroup。
- 567 count/rate。
- bot cookie expired events。

### 5. SDGB / Auto Update

图表：

- rival probe count。
- rival changed/no_change/failed。
- map probe count/delta/failed。
- sdgb API latency p95。
- auto update queue lag。
- tier distribution。
- FC/FS enrichment count/failed。

### 6. Logs

ClickHouse structured logs 查询：

- service。
- instance。
- level。
- workerId。
- jobId。
- time range。
- text contains。

默认只查最近 15 分钟，支持扩到 24h/7d。raw HTML 不在这里展示。

### 7. Job Debug

组合视图：

1. Mongo current job。
2. `job_timeline_events`。
3. `external_api_calls`。
4. `structured_logs` filtered by `jobId`。
5. artifact viewer，如果 `artifactKey` 仍可用。

## Alert 规则

初始只做高信号规则，避免噪音。

| 规则 | 条件 | 严重性 | 数据源 |
| --- | --- | --- | --- |
| Backend replica unhealthy | healthy backend replica < 2 持续 2m | critical | realtime |
| Mongo memory near cap | Mongo memory > 90% cap 持续 5m | warning | realtime |
| Mongo disk low | Server 5 `/` available < 10GB | warning | realtime |
| Redis unavailable | ping failed 持续 1m | critical | realtime |
| ClickHouse unavailable | ping failed 持续 1m | critical | realtime |
| ClickHouse insert lag high | insert lag > 60s 持续 5m | warning | realtime |
| Worker offline | heartbeat age > 5m | warning | Redis |
| No cabinet bot | available cabinet bot 数为 0 持续 2m | critical | Mongo |
| DXNet 567 spike | 5m 内 567 > 30 或 > 近 24h 同窗口均值 3 倍 | warning | ClickHouse |
| API 5xx spike | 15m 5xx rate > 5% 且 5xx > 20 | warning | ClickHouse |
| Frontend JS error spike | 15m JS error > 30 | warning | ClickHouse |
| sdgb failed spike | 5m failed rate > 2% 且 failed > 5 | warning | ClickHouse |
| Auto update lag | rival due oldest age > 20m | warning | Mongo |
| Queue backlog | oldest queued age > 10m | warning | Redis/Mongo |
| Artifact disk high | artifact volume usage > 80% | warning | realtime |

## Alert 订阅

订阅绑定 label，不绑定具体页面：

```ts
{
  id: string;
  name: string;
  enabled: boolean;
  labels: {
    severity?: "warning" | "critical";
    subsystem?: "backend" | "dxnet" | "sdgb" | "auto_update" | "storage" | "frontend";
  };
  channel: "feishu" | "webhook" | "email";
  target: string;
  quietHours?: { start: string; end: string; timezone: string };
  createdAt: Date;
  updatedAt: Date;
}
```

通知内容：

- alert 名称、严重级别。
- 当前值、阈值、窗口。
- 触发持续时间。
- admin deep link。
- 最近 5 条相关 trace/log 摘要。
- 不附 raw body。

## Alert evaluator

第一阶段内建 evaluator：

1. backend cron 每 30s 评估。
2. realtime 规则读 Redis/Mongo current state。
3. history 规则查 ClickHouse 最近窗口。
4. 使用 `forSec` 防抖。
5. 使用 `cooldownSec` 限制重复通知。
6. alert events 存 Mongo，长期趋势可同步写 ClickHouse。

后续如果需要成熟 silence/routing，再接 Prometheus/Alertmanager；不是第一阶段前置依赖。
