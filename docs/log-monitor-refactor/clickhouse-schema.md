# ClickHouse 表设计

本文给出第一阶段要建的 ClickHouse 表。目标是单体可维护、查询直观、避免高基数误用。

## 基础约定

- database: `maimai_observability`
- engine: `MergeTree`
- 时间字段统一 `DateTime64(3, 'Asia/Shanghai')`
- 分区按月：`PARTITION BY toYYYYMM(ts)`
- 常用排序：低基数字段 + `ts`
- 所有明细表都带 `environment LowCardinality(String)`，取值 `prod` / `dev`。prod/dev 共用 ClickHouse 实例时，所有 dashboard 查询必须显式过滤 environment。
- raw HTML / large body 不进 ClickHouse，只保存 `artifactKey`
- 用户标识使用明文 `friendCode`；用户确认 friendCode 不是敏感信息。
- bot 标识使用明文 `botFriendCode`。
- Mongo `_id` 不进入 ClickHouse，除非后续有明确排障需求。
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
  environment LowCardinality(String),
  service LowCardinality(String),
  instance LowCardinality(String),
  method LowCardinality(String),
  routeTemplate LowCardinality(String),
  statusCode UInt16,
  statusClass LowCardinality(String),
  durationMs UInt32,
  requestBytes UInt32,
  responseBytes UInt32,
  friendCode String,
  ipHash String,
  userAgentHash String,
  errorClass LowCardinality(String),
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (environment, service, routeTemplate, method, ts)
TTL toDateTime(ts) + INTERVAL 180 DAY DELETE;
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
  environment LowCardinality(String),
  sessionId String,
  friendCode String,
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
ORDER BY (environment, routeTemplate, ts)
TTL toDateTime(ts) + INTERVAL 180 DAY DELETE;
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
  environment LowCardinality(String),
  eventName LowCardinality(String),
  friendCode String,
  sessionId String,
  routeTemplate LowCardinality(String),
  source LowCardinality(String),
  appVersion LowCardinality(String),
  properties Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (environment, eventName, ts)
TTL toDateTime(ts) + INTERVAL 365 DAY DELETE;
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

- `site_dau`: 当天有 `page_view` 的 distinct `friendCode`。
- `sync_dau`: 当天有 `sync_started` / `sync_completed` 的 distinct `friendCode`。
- `login_dau`: 当天有 `login_success` 的 distinct `friendCode`。

## `structured_logs`

结构化日志，替代 Mongo `worker_logs`。

```sql
CREATE TABLE structured_logs
(
  ts DateTime64(3, 'Asia/Shanghai'),
  environment LowCardinality(String),
  service LowCardinality(String),
  instance LowCardinality(String),
  level LowCardinality(String),
  message String,
  traceId String,
  requestId String,
  jobId String,
  workerKind LowCardinality(String),
  workerId LowCardinality(String),
  botFriendCode String,
  eventName LowCardinality(String),
  errorClass LowCardinality(String),
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (environment, service, level, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY DELETE;
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
  environment LowCardinality(String),
  jobId String,
  workerKind LowCardinality(String),
  workerId LowCardinality(String),
  botFriendCode String,
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
ORDER BY (environment, target, apiGroup, statusCode, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY DELETE;
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

## `job_timeline_events`

job 状态流转和 stage 变化。

```sql
CREATE TABLE job_timeline_events
(
  ts DateTime64(3, 'Asia/Shanghai'),
  environment LowCardinality(String),
  jobId String,
  jobKind LowCardinality(String),
  jobType LowCardinality(String),
  eventName LowCardinality(String),
  fromStatus LowCardinality(String),
  toStatus LowCardinality(String),
  fromStage LowCardinality(String),
  toStage LowCardinality(String),
  workerId LowCardinality(String),
  botFriendCode String,
  durationMs UInt32,
  errorClass LowCardinality(String),
  message String,
  attrs Map(String, String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (environment, jobId, ts)
TTL toDateTime(ts) + INTERVAL 180 DAY DELETE;
```

用于 job debug 页面按时间线展示。

## materialized views

第一阶段建议建聚合表，避免 admin dashboard 每次扫明细。

### `api_stats_1m`

```sql
CREATE MATERIALIZED VIEW api_stats_1m
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (bucket, environment, service, routeTemplate, method, statusClass)
AS
SELECT
  toStartOfMinute(ts) AS bucket,
  environment,
  service,
  routeTemplate,
  method,
  statusClass,
  count() AS requests,
  countIf(statusCode >= 500) AS serverErrors,
  countIf(statusCode >= 400) AS clientOrServerErrors,
  sum(durationMs) AS durationSumMs
FROM http_requests
GROUP BY bucket, environment, service, routeTemplate, method, statusClass;
```

精确 p95/p99 建议从明细表按窗口查，或后续改用 `AggregatingMergeTree` 保存 quantile state。

### `dau_daily`

```sql
CREATE MATERIALIZED VIEW dau_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (day, environment, eventName)
AS
SELECT
  toDate(ts) AS day,
  environment,
  eventName,
  uniqState(friendCode) AS users
FROM analytics_events
WHERE friendCode != ''
GROUP BY day, environment, eventName;
```

### `external_api_stats_5m`

```sql
CREATE MATERIALIZED VIEW external_api_stats_5m
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (bucket, environment, target, apiGroup, statusClass, errorClass)
AS
SELECT
  toStartOfInterval(ts, INTERVAL 5 MINUTE) AS bucket,
  environment,
  target,
  apiGroup,
  statusClass,
  errorClass,
  count() AS calls,
  sum(durationMs) AS durationSumMs,
  sum(bodySize) AS bodyBytes
FROM external_api_calls
GROUP BY bucket, environment, target, apiGroup, statusClass, errorClass;
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
WHERE environment = 'prod'
  AND ts >= now() - INTERVAL 1 DAY
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
WHERE environment = 'prod'
  AND ts >= now() - INTERVAL 1 DAY
GROUP BY routeTemplate
ORDER BY p95 DESC;
```

DAU：

```sql
SELECT
  toDate(ts) AS day,
  uniqExact(friendCode) AS dau
FROM analytics_events
WHERE eventName = 'page_view'
  AND environment = 'prod'
  AND friendCode != ''
GROUP BY day
ORDER BY day;
```

Job debug trace：

```sql
SELECT *
FROM external_api_calls
WHERE environment = {environment:String}
  AND jobId = {jobId:String}
ORDER BY ts ASC;
```

## 脱敏与禁止入库

`friendCode` 和 `botFriendCode` 可以明文入 ClickHouse。其余敏感或高风险内容按下表处理：

| 类型 | 字段/内容 | 处理 |
| --- | --- | --- |
| 密码 | 明文密码、`currentPassword`、`newPassword` | 永不记录 |
| 密码 hash | `passwordHash` | 不进 ClickHouse / logs |
| JWT | `Authorization: Bearer ...`、`netbot_token` | 只记录是否存在，不记录值 |
| Admin/API secret | `ADMIN_PASSWORD`、`API_SHARED_SECRET`、`X-Admin-Password`、`X-API-Secret` | 永不记录 |
| DB/Redis 密码 | `MONGO_PASSWORD`、`REDIS_PASSWORD`、ClickHouse password | 永不记录 |
| 查分器 token | `divingFishImportToken`、`lxnsImportToken` | 永不记录 |
| maimai cookie | `Cookie`、`Set-Cookie`、worker cookie jar | 永不记录 |
| OAuth/recovery URL | ADB recovery URL、带登录态/跳转 token 的 URL | 不记录完整 URL，只记录 `urlGroup` |
| QR 原文 | 机台二维码 raw payload、登录二维码内容 | 不进 ClickHouse；只在业务流程短期使用 |
| raw HTML body | DXNet 页面 HTML、错误页面 HTML | 不进 ClickHouse；需要时进 artifact，短 TTL |
| 大 JSON body | 外部 API 大响应、含用户成绩/个人信息 payload | 默认不进 ClickHouse；只存 `bodySize` / `bodyHash` / `artifactKey` |
| 请求 header | `Cookie`、`Authorization`、secret header | 敏感 header 删除 |
| IP 地址 | 客户端 IP | 存 `ipHash`，不存明文 |
| User-Agent | 完整 UA | 默认存 `userAgentHash` 或粗分类 browser/os/device |
| 错误堆栈 | 可能包含 token、URL、body 的 stack | scrub 后再记录 |
| artifact 内容 | raw HTML / dump 文件 | admin-only，TTL，大小限制 |
