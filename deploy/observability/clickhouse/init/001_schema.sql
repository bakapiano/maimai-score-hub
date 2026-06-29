CREATE DATABASE IF NOT EXISTS maimai_observability;

USE maimai_observability;

CREATE TABLE IF NOT EXISTS http_requests
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

CREATE TABLE IF NOT EXISTS frontend_rum
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

CREATE TABLE IF NOT EXISTS analytics_events
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

CREATE TABLE IF NOT EXISTS structured_logs
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

CREATE TABLE IF NOT EXISTS external_api_calls
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

CREATE TABLE IF NOT EXISTS job_timeline_events
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

CREATE MATERIALIZED VIEW IF NOT EXISTS api_stats_1m
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

CREATE MATERIALIZED VIEW IF NOT EXISTS dau_daily
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

CREATE MATERIALIZED VIEW IF NOT EXISTS external_api_stats_5m
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
