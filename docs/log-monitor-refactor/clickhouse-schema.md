# ClickHouse 表设计

本文给出第一阶段要建的 ClickHouse 表。目标是单体可维护、查询直观、避免高基数误用。

## 基础约定

- database: `maimai_observability`
- engine: `MergeTree`
- 时间字段统一 `DateTime64(3, 'Asia/Shanghai')`
- 分区按月：`PARTITION BY toYYYYMM(ts)`
- 常用排序：低基数字段 + `ts`
- raw HTML / large body 不进 ClickHouse，只保存 `artifactKey`
- 用户标识使用 `userIdHash`，不直接保存 friendCode 或 Mongo `_id`
- route 使用模板，不保存真实无限路径

```sql
CREATE DATABASE IF NOT EXISTS maimai_observability;
USE maimai_observability;
```

## `http_requests`

backend API 请求明细。

```sql
CREATE TABLE http_requests
(
  ts DateTime64(3, 'Asia/Shanghai'),
  traceId String,
  requestId String,
  service LowCardinality(String),
  instance LowCardinality(String),
  method LowCardinality(String),
  routeTemplate LowCardinality(String),
  statusCode UInt16,
  statusClass LowCardinality(String),
  durationMs UInt32,
  requestBytes UInt32,
  responseBytes UInt32,
  userIdHash String,
  ipHash String,
  userAgentHash String,
  errorClass LowCardinality(String),
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (service, routeTemplate, method, ts)
TTL ts + INTERVAL 180 DAY DELETE;
```

用于：

- 每 API 访问量。
- p50/p95/p99 latency。
- 错误率。
- route 维度性能趋势。

## `frontend_rum`

前端真实用户性能和错误。

```sql
CREATE TABLE frontend_rum
(
  ts DateTime64(3, 'Asia/Shanghai'),
  sessionId String,
  userIdHash String,
  routeTemplate LowCardinality(String),
  pageUrlHash String,
  referrerHash String,
  browser LowCardinality(String),
  os LowCardinality(String),
  deviceType LowCardinality(String),
  fcpMs UInt32,
  lcpMs UInt32,
  inpMs UInt32,
  cls Float32,
  ttfbMs UInt32,
  loadMs UInt32,
  apiWaitMs UInt32,
  jsError UInt8,
  errorName LowCardinality(String),
  errorMessageHash String,
  traceId String,
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (routeTemplate, ts)
TTL ts + INTERVAL 180 DAY DELETE;
```

用于：

- route load p95。
- Web Vitals。
- JS error rate。
- 前端版本发布后性能回归。

## `analytics_events`

产品行为和 DAU。

```sql
CREATE TABLE analytics_events
(
  ts DateTime64(3, 'Asia/Shanghai'),
  eventName LowCardinality(String),
  userIdHash String,
  sessionId String,
  routeTemplate LowCardinality(String),
  source LowCardinality(String),
  appVersion LowCardinality(String),
  properties Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (eventName, ts)
TTL ts + INTERVAL 365 DAY DELETE;
```

建议事件：

| eventName | 说明 |
| --- | --- |
| `page_view` | 页面访问 |
| `login_success` | 登录成功 |
| `sync_started` | 用户发起同步 |
| `sync_completed` | 同步完成 |
| `sync_failed` | 同步失败 |
| `cabinet_bind_started` | 机台绑定开始 |
| `cabinet_bind_completed` | 机台绑定完成 |
| `export_started` | 查分器导出开始 |
| `export_completed` | 查分器导出完成 |
| `auto_update_enabled` | 开启自动更新 |
| `auto_update_disabled` | 关闭自动更新 |

DAU 定义：

- `site_dau`: 当天有 `page_view` 的 distinct `userIdHash`。
- `sync_dau`: 当天有 `sync_started` / `sync_completed` 的 distinct `userIdHash`。
- `login_dau`: 当天有 `login_success` 的 distinct `userIdHash`。

## `structured_logs`

结构化日志，替代 Mongo `worker_logs`。

```sql
CREATE TABLE structured_logs
(
  ts DateTime64(3, 'Asia/Shanghai'),
  service LowCardinality(String),
  instance LowCardinality(String),
  level LowCardinality(String),
  message String,
  traceId String,
  requestId String,
  jobId String,
  workerKind LowCardinality(String),
  workerId LowCardinality(String),
  botFriendCodeHash String,
  eventName LowCardinality(String),
  errorClass LowCardinality(String),
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (service, level, ts)
TTL ts + INTERVAL 30 DAY DELETE;
```

用于：

- 7-30 天日志查询。
- error log 趋势。
- job/worker 相关日志排障。

## `external_api_calls`

worker/backend 调外部服务的明细，替代 Mongo `job_api_logs`。

```sql
CREATE TABLE external_api_calls
(
  ts DateTime64(3, 'Asia/Shanghai'),
  traceId String,
  jobId String,
  workerKind LowCardinality(String),
  workerId LowCardinality(String),
  botFriendCodeHash String,
  target LowCardinality(String),
  apiGroup LowCardinality(String),
  method LowCardinality(String),
  urlGroup LowCardinality(String),
  statusCode UInt16,
  statusClass LowCardinality(String),
  durationMs UInt32,
  bodySize UInt32,
  bodyHash String,
  artifactKey String,
  errorClass LowCardinality(String),
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (target, apiGroup, statusCode, ts)
TTL ts + INTERVAL 90 DAY DELETE;
```

`urlGroup` 示例：

- `maimai.friend.pages`
- `maimai.friend.index`
- `maimai.friend.favorite_on`
- `maimai.friend.invite`
- `maimai.friend.genre_vs`
- `sdgb.get_rival_music`
- `sdgb.get_user_map`
- `sdgb.add_rival`
- `diving_fish.export`
- `lxns.export`

## `worker_events`

worker 生命周期和业务事件。

```sql
CREATE TABLE worker_events
(
  ts DateTime64(3, 'Asia/Shanghai'),
  service LowCardinality(String),
  workerKind LowCardinality(String),
  workerId LowCardinality(String),
  eventName LowCardinality(String),
  jobId String,
  botFriendCodeHash String,
  status LowCardinality(String),
  durationMs UInt32,
  errorClass LowCardinality(String),
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (workerKind, eventName, ts)
TTL ts + INTERVAL 180 DAY DELETE;
```

事件示例：

- `worker_started`
- `worker_stopped`
- `bot_cookie_expired`
- `bot_status_reported`
- `job_picked`
- `job_completed`
- `job_failed`
- `auto_update_probe_completed`
- `auto_update_probe_failed`

## `job_timeline_events`

job 状态流转和 stage 变化。

```sql
CREATE TABLE job_timeline_events
(
  ts DateTime64(3, 'Asia/Shanghai'),
  jobId String,
  jobKind LowCardinality(String),
  jobType LowCardinality(String),
  eventName LowCardinality(String),
  fromStatus LowCardinality(String),
  toStatus LowCardinality(String),
  fromStage LowCardinality(String),
  toStage LowCardinality(String),
  workerId LowCardinality(String),
  botFriendCodeHash String,
  durationMs UInt32,
  errorClass LowCardinality(String),
  message String,
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (jobId, ts)
TTL ts + INTERVAL 180 DAY DELETE;
```

用于 job debug 页面按时间线展示。

## `cost_events`

近期花费、调用预算、外部 API 消耗。

```sql
CREATE TABLE cost_events
(
  ts DateTime64(3, 'Asia/Shanghai'),
  source LowCardinality(String),
  category LowCardinality(String),
  unit LowCardinality(String),
  quantity Float64,
  estimatedCost Float64,
  currency LowCardinality(String),
  jobId String,
  userIdHash String,
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (source, category, ts)
TTL ts + INTERVAL 365 DAY DELETE;
```

第一阶段即使没有真实金额，也可以先记录调用量：

- `sdgb.get_rival_music` quantity = 1。
- `sdgb.get_user_map` quantity = 1。
- `dxnet.friend_vs_page` quantity = 1。
- `prober_export.diving_fish` quantity = 1。
- `image_render.best50` quantity = 1。

## materialized views

第一阶段建议建聚合表，避免 admin dashboard 每次扫明细。

### `api_stats_1m`

```sql
CREATE MATERIALIZED VIEW api_stats_1m
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (bucket, service, routeTemplate, method, statusClass)
AS
SELECT
  toStartOfMinute(ts) AS bucket,
  service,
  routeTemplate,
  method,
  statusClass,
  count() AS requests,
  countIf(statusCode >= 500) AS serverErrors,
  countIf(statusCode >= 400) AS clientOrServerErrors,
  sum(durationMs) AS durationSumMs
FROM http_requests
GROUP BY bucket, service, routeTemplate, method, statusClass;
```

精确 p95/p99 建议从明细表按窗口查，或后续改用 `AggregatingMergeTree` 保存 quantile state。

### `dau_daily`

```sql
CREATE MATERIALIZED VIEW dau_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (day, eventName)
AS
SELECT
  toDate(ts) AS day,
  eventName,
  uniqState(userIdHash) AS users
FROM analytics_events
WHERE userIdHash != ''
GROUP BY day, eventName;
```

### `external_api_stats_5m`

```sql
CREATE MATERIALIZED VIEW external_api_stats_5m
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (bucket, target, apiGroup, statusClass, errorClass)
AS
SELECT
  toStartOfInterval(ts, INTERVAL 5 MINUTE) AS bucket,
  target,
  apiGroup,
  statusClass,
  errorClass,
  count() AS calls,
  sum(durationMs) AS durationSumMs,
  sum(bodySize) AS bodyBytes
FROM external_api_calls
GROUP BY bucket, target, apiGroup, statusClass, errorClass;
```

## 查询示例

每 API 24h 错误率：

```sql
SELECT
  routeTemplate,
  count() AS total,
  countIf(statusCode >= 500) AS server_errors,
  round(server_errors / total * 100, 2) AS error_rate
FROM http_requests
WHERE ts >= now() - INTERVAL 1 DAY
GROUP BY routeTemplate
ORDER BY server_errors DESC;
```

每 API p95：

```sql
SELECT
  routeTemplate,
  quantile(0.95)(durationMs) AS p95,
  quantile(0.99)(durationMs) AS p99
FROM http_requests
WHERE ts >= now() - INTERVAL 1 DAY
GROUP BY routeTemplate
ORDER BY p95 DESC;
```

DAU：

```sql
SELECT
  toDate(ts) AS day,
  uniqExact(userIdHash) AS dau
FROM analytics_events
WHERE eventName = 'page_view'
  AND userIdHash != ''
GROUP BY day
ORDER BY day;
```

Job debug trace：

```sql
SELECT *
FROM external_api_calls
WHERE jobId = {jobId:String}
ORDER BY ts ASC;
```
