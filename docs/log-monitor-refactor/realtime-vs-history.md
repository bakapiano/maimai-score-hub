# 实时监控与历史分析边界

admin portal 需要拆成两个心智模型：**现在是否健康** 和 **历史趋势如何**。

## 线上实时监控

实时监控回答：

- worker 是否在线。
- bot cookie 是否可用。
- 当前队列是否堆积。
- 最近 5-15 分钟是否异常。
- ClickHouse ingest 是否正常。
- 近期调用/成本是否超预算。

实时数据允许短 TTL、允许重启丢失一部分；它必须读得快、表达当前状态。

### 实时数据源

| 数据 | 数据源 | 存储 |
| --- | --- | --- |
| backend health | `/health` + container state | runtime |
| Mongo health | ping / collection stats / memory | runtime |
| Redis health | ping / used memory / queue state | Redis |
| ClickHouse health | ping / insert lag / disk | ClickHouse system tables |
| worker heartbeat | worker 上报 | Redis，TTL 2-5min |
| bot availability | `bot_statuses` | Mongo |
| active DXNet jobs | `jobs` status in queued/processing | Mongo |
| active sdgb jobs | `sdgb_jobs` queued/processing | Mongo |
| BullMQ depth | queue counts | Redis |
| rate-limit buckets | token bucket state | Redis |
| recent errors | 最近 5-15m ClickHouse 查询 | ClickHouse |
| recent usage / upstream pressure | `external_api_calls` 最近 1h/24h | ClickHouse |

### 实时指标

| 指标 | 说明 |
| --- | --- |
| `backend.healthy_replicas` | backend 健康副本数 |
| `mongo.memory_used_ratio` | Mongo 容器内存使用 / cap |
| `mongo.disk_free_bytes` | Server 5 根盘或 Mongo volume 剩余 |
| `redis.used_memory_bytes` | Redis 内存 |
| `clickhouse.insert_lag_seconds` | 最近事件入库延迟 |
| `clickhouse.disk_free_bytes` | ClickHouse 数据盘剩余 |
| `worker.online_count` | 在线 worker 数 |
| `worker.heartbeat_age_seconds` | 每个 worker 的 heartbeat age |
| `bot.available_count` | 可用 bot 数 |
| `bot.cabinet_available_count` | 配置 cabinet userId 且可用的 bot 数 |
| `dxnet.queue_depth` | DXNet queued/processing |
| `sdgb.queue_depth` | sdgb queued/processing |
| `auto_update.due_backlog` | 到期但未处理的 probe state 数 |
| `rate_limit.tokens_remaining` | 关键 API token bucket 剩余 |
| `usage.external_calls_today` | 今日外部调用量 |
| `usage.upstream_error_rate` | 近期上游错误率 |

## 历史分析数据

历史分析回答：

- DAU 如何变化。
- 每个 API 的访问量、latency、错误率如何变化。
- 前端 route load time 是否变慢。
- worker / sdgb / external API 的长期错误率。
- 自动更新是否按容量目标运行。
- 哪些功能被使用，哪些流程失败。

历史数据应该写 ClickHouse，保留 30-365 天，支持 SQL 和 dashboard。

### 历史数据集

| 数据集 | 用途 |
| --- | --- |
| `analytics_events` | DAU、功能使用、漏斗 |
| `http_requests` | backend API QPS、latency、错误率 |
| `frontend_rum` | Web Vitals、route load、JS error |
| `structured_logs` | backend/worker/sdgb 历史日志 |
| `external_api_calls` | DXNet/sdgb/prober 外部调用统计 |
| `job_timeline_events` | job 状态流转和排障 |

### 历史指标

| 指标 | 来源 |
| --- | --- |
| DAU / WAU / MAU | `analytics_events` distinct `friendCode` |
| route PV / UV | `analytics_events` |
| API requests per route | `http_requests` |
| API p50/p95/p99 latency | `http_requests` |
| API error rate | `http_requests` |
| frontend LCP / INP / CLS | `frontend_rum` |
| frontend route load p95 | `frontend_rum` |
| JS error count/rate | `frontend_rum` |
| worker log error count | `structured_logs` |
| external API status/latency | `external_api_calls` |
| DXNet 567 count/rate | `external_api_calls.errorClass = 'rate_limit_567'` |
| sdgb job throughput/error | `job_timeline_events` / `external_api_calls` |
| auto update probe success/change/no-change | `job_timeline_events` / `external_api_calls` |
| external calls per day | `external_api_calls` |

## admin portal 重构

推荐拆为两个入口：

1. **Realtime**
   - 当前健康、worker、bot、queue、最近错误、今日成本。
   - 自动刷新 5-15 秒。
   - 数据主要来自 Mongo/Redis current state + ClickHouse 最近窗口。

2. **History**
   - API、RUM、DAU、worker、external API、usage。
   - 默认窗口 24h / 7d / 30d。
   - 数据来自 ClickHouse。

Job Debug 是第三类入口：

- 当前状态来自 Mongo。
- 时间线、日志、外部 API trace 来自 ClickHouse。
- raw body 来自 artifact。
