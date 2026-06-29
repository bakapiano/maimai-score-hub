# 看板与 Alert 订阅

## 页面结构

### 1. Overview

目标：打开 admin 第一屏就能判断系统是不是健康。

卡片：

- backend replicas：健康副本数、最近 deploy revision。
- Mongo：memory usage / cap、disk、慢查询或超时数。
- Redis：memory、connected、stream length、evicted keys。
- DXNet workers：在线 worker 数、在线 bot 数、cookie expired 数。
- sdgb-worker：heartbeat age、active/queued job 数、错误率。
- 近 15 分钟错误：DXNet API error、567、sdgb failed、job failed。

趋势图：

- `dxnet.job.completed/failed` per 5m。
- `sdgb.job.completed/failed` per 5m。
- `auto_update.rival.changed/no_change/failed` per 5m。
- `dxnet.rate_limit.567` per 5m。

### 2. DXNet Worker

目标：排查 bot、DXNet job、recent event、好友容量。

组件：

- Bot 表：friendCode、remark、available、lastReportedAt、friendCount、cabinetUserId、in-flight jobs。
- Per-bot queue：queued/processing/delayed、oldest queued age。
- API 状态码热力：2xx/3xx/4xx/5xx/567。
- recent event QPS 和失败率。
- Redis Stream 日志 tail，支持 kind/worker/level/q/since/limit。

### 3. SDGB / Auto Update

目标：看 Rival-first 自动更新链路是否跟得上。

组件：

- Auto-update users：enabled、hot/warm/cold 分布。
- Due backlog：rival/map/recent due count、oldest due age。
- Rival probe：count、changed/no_change、failed、latency p50/p95、payload bytes。
- Map auxiliary：count、delta/no_delta、failed、latency p50/p95。
- FC/FS enrichment：created/completed/failed、recent event hit rate、fallback update_score 数。
- sdgb job queue：queued/processing/completed/failed by type。

### 4. Job Debug

目标：围绕一个 job 看完整链路，不再看散乱表。

展示顺序：

1. Job 基本信息：id、friendCode、jobType、status、stage、bot、createdAt、updatedAt、error。
2. 状态时间线：created -> queued -> processing -> stage changes -> completed/failed。
3. API trace：method、url、statusCode、durationMs、bodySize、errorClass、createdAt。
4. 相关 business links：syncId、auto_update_task、sdgb_job、prober_export_job。
5. 可选 artifact：只有开启 debug artifact 且仍在 TTL 内才显示。

### 5. Storage / Retention

目标：避免再次出现 TTL index 漂移和 debug collection 膨胀。

展示：

- Mongo collection stats：count、size、storageSize、indexSize。
- TTL index audit：schema 期望 vs 线上实际。
- Redis key/stream stats：stream length、memory、oldest/newest entry。
- debug artifact volume usage。
- retention 配置：worker log maxlen、API debug TTL、artifact TTL。

## Alert 规则建议

初始只做高信号规则，避免噪音。

| 规则 | 条件 | 严重性 | 数据源 |
| --- | --- | --- | --- |
| Backend replica unhealthy | healthy backend replica < 2 持续 2m | critical | health/current state |
| Mongo memory near cap | Mongo container memory > 90% cap 持续 5m | warning | storage collector |
| Mongo disk low | Server 5 `/` available < 10GB | warning | storage collector |
| Redis unavailable | backend ping Redis 失败持续 1m | critical | Redis health |
| Worker offline | worker heartbeat/log age > 5m | warning | Redis worker status |
| Bot unavailable | available cabinet bot 数为 0 持续 2m | critical | `bot_statuses` |
| DXNet 567 spike | 5m 内 567 > 30 或 > 最近均值 3 倍 | warning | metric bucket |
| DXNet job fail spike | 15m failed rate > 10% 且 failed > 10 | warning | metric bucket |
| sdgb failed spike | 5m failed rate > 2% 且 failed > 5 | warning | metric bucket |
| Auto update lag | rival due oldest age > 20m | warning | auto_update state |
| sdgb queue lag | queued/processing oldest age > 5m | warning | sdgb job state |
| Log retention broken | `worker_logs` / `job_api_logs` Mongo count 持续增长 | warning | storage audit |

## 订阅模型

订阅不直接绑定页面，而是绑定 alert label：

```ts
{
  id: string;
  name: string;
  enabled: boolean;
  labels: {
    severity?: "warning" | "critical";
    subsystem?: "dxnet" | "sdgb" | "auto_update" | "storage";
  };
  channel: "feishu" | "webhook" | "email";
  target: string;
  quietHours?: { start: string; end: string; timezone: string };
  createdAt: Date;
  updatedAt: Date;
}
```

通知内容统一包含：

- alert 名称、严重级别、当前值、阈值。
- 触发窗口和持续时间。
- admin deep link，例如 `/admin/job-debug?jobId=...` 或 `/admin/monitor?tab=sdgb`。
- 最近 5 条相关 trace/log 摘要，不附 raw body。

## 告警评估方式

短期实现：

1. backend cron 每 30s 评估规则。
2. 从 Redis current-state 和 Mongo `monitor_metric_buckets` 取窗口数据。
3. 使用 `forSec` 防抖，使用 `cooldownSec` 限制重复通知。
4. `monitor_alert_events` 记录 firing/resolved。

后续如果接 Prometheus/Alertmanager：

- `monitor_metric_buckets` 可以继续服务 admin 历史图。
- Alertmanager 接管规则评估和通知 fan-out。
- admin 订阅 UI 可以同步 Alertmanager silence / route，也可以保持轻量内建。

