# Log / Monitor / Analytics 重构方案总览

本文档给出 admin portal、日志、线上实时监控、历史分析、ClickHouse 单体部署和后续 alert 订阅的重构方案。可以接受 breaking change，因此方案不保留现有“每个 debug 页面各自入库”的兼容包袱。

## 当前实现状态（PR #8 / dev）

已实现并在 dev smoke 通过：

- 101 上部署 ClickHouse single node 和 artifact service。
- backend `ObservabilityModule` 批量写入 ClickHouse。
- backend HTTP interceptor 写 `http_requests`。
- frontend 写 `frontend_rum` 和 `analytics_events`。
- worker 写 `structured_logs` 和 `external_api_calls`；backend 内部外部依赖也写 `external_api_calls`。
- DXNet / SDGB job 状态变化写 `job_timeline_events`。
- admin Realtime / History / Logs / Job Debug 查询 ClickHouse。
- 旧 `WorkerLogsModule`、`JobApiLogService`、Redis Stream worker logs 和旧 `api-logs` endpoints 已删除。

当前未实现：

- worker/backend 自动上传 raw response artifact。artifact service 已部署并单独验收可写可读，但 `external_api_calls.artifactKey` 目前只有调用方显式传入时才有值。
- sdgb-worker 协议调用的具体 metadata 需要在 top-level untracked `sdgb-worker/` 中调用 `/workers/:kind/external-api-calls` 接入；backend 已提供通用入口。
- alert rules / subscriptions。
- 成熟的 debug capture 开关、artifact viewer UI。

## 范围与基准

- 用户口径说“线上 master”，但当前仓库没有 `master` / `origin/master`；本地 `origin/HEAD` 指向 `origin/main`。
- 线上 backend `/root/maimai-score-hub-backend/.deploy-revision` 为 `10b887c0ef7149b2fe98dc5c8e588e7ace01f44d`，被本地 `main` 包含；`10b887c..main` 只有部署归档提交，没有业务代码 diff。
- 因此本文把 `main` 作为线上代码基准，把当前工作区 `dev` 里的 Redis 改动视为“已有演进方向，但尚非线上事实”。
- 线上数据来自 2026-06-29 08:45-09:00 Asia/Shanghai 的只读 SSH / `mongosh` 查询；没有使用未验证的推测数字。

## 线上关键事实

### 机器状态

| 节点 | 角色 | 当前状态 |
| --- | --- | --- |
| Server 5 `175.178.13.169` | backend×2 + nginx + MongoDB 7 | 2 vCPU / 8GB RAM / 60GB disk；load `0.55 0.45 0.30`；内存 available `4.5GiB`；根盘 `17G/60G`；Mongo 容器 `2.879GiB / 3.5GiB` |
| Server 1 `124.220.225.153` | DXNet worker | 2GB RAM；load 接近 0；根盘 `13G/50G`；worker 容器 up 2h |
| Server 2 `106.14.237.126` | DXNet worker + public nginx | 2GB RAM；available `1.1GiB`；根盘 `18G/40G`；worker 容器 up 4d |
| Server 4 `192.168.1.101` | DXNet worker + sdgb-worker + adb-worker | 16GB RAM；available `11GiB`；根盘 `66G/457G`；sdgb-worker up 3d，worker up 9d |
| Server 3 `20.2.80.144` | frontend | 8GB RAM；根盘 `22G/29G`，磁盘偏紧；未取得 docker ps 权限，不作为本方案的服务端容量依据 |

### MongoDB 规模

| Collection | 文档数 | 逻辑大小 | storageSize | 说明 |
| --- | ---: | ---: | ---: | --- |
| `job_api_logs` | 102,169 | 6.96GB | 953MB | admin job debug 的外部 API 响应体是主要体积来源 |
| `sdgb_jobs` | 86,870 | 10.50GB | 2.30GB | 24h 内约 86,747 条，TTL 1 天已生效 |
| `worker_logs` | 1,933,769 | 494MB | 116MB | 控制台日志火力高，且线上 TTL 没生效 |
| `jobs` | 13,549 | 804MB | 310MB | 7 天 TTL 已生效，业务 source of truth |
| `syncs` | 5,958 | 983MB | 248MB | 用户成绩快照，永久数据 |
| `userentities` | 7,204 | 6.1MB | 3.8MB | 当前用户量基数 |

过去 24h 写入量：

| 数据 | 24h 新增 |
| --- | ---: |
| `worker_logs` | 250,727 |
| `job_api_logs` | 9,412 |
| `jobs` | 2,319 |
| `sdgb_jobs` | 86,747 |
| `auto_update_runs` | 288 |

现状观察：

| Collection | schema 期望 | 线上实际 |
| --- | --- | --- |
| `worker_logs` | `ts` 2h TTL | 无 TTL index；`1,914,194` 条已超过 2h |
| `job_api_logs` | `createdAt` 24h TTL | 无 TTL index；`92,757` 条已超过 24h |
| `sdgb_jobs` | `createdAt` 1d TTL | 已生效 |
| `jobs` | `createdAt` 7d TTL | 已生效 |

## 重新定义目标

现有 admin portal 的问题不是“缺一个日志搜索框”，而是三类需求混在一起：

1. **线上实时监控**：现在是否健康，worker 是否在线，队列是否堆积，近 5-15 分钟是否异常，今天外部调用量和上游压力如何。
2. **历史分析数据**：历史 DAU、每个 API 的访问量、p50/p95/p99 latency、错误率、前端 load time、RUM、功能使用趋势。
3. **排障上下文**：点开一个 job 或一段时间，查看 worker log、外部 API 调用、错误和可选 raw HTML artifact。

因此本方案的核心不是“上日志栈”，而是：

```text
MongoDB    = 业务 source of truth
Redis      = BullMQ / lock / rate limit / heartbeat / 当前状态
ClickHouse = 历史观测与分析仓库
Artifact   = raw HTML / large body / debug dump
```

prod 和 dev 可以共用 101 上的 ClickHouse / artifact service，但必须用 `environment = 'prod' | 'dev'` 隔离查询、看板和 artifact 路径；默认 admin 历史看板只查 prod。

## 技术选型

### 1. MongoDB 继续作为业务状态库

保留 MongoDB 作为下列数据的 source of truth：

- `users` / `syncs` / `jobs` / `sdgb_jobs`
- `bot_statuses` / `auto_update_probe_states` / `auto_update_tasks`
- alert rules、alert subscriptions、少量 admin 配置

MongoDB 不再保存：

- worker console logs
- job external API raw body
- API access logs
- frontend RUM
- DAU / product analytics event

原因：线上 Mongo 容器已经到 `2.879GiB / 3.5GiB`，继续塞 raw debug payload 会挤压业务查询；历史统计也不应该从业务集合和日志文本里临时 grep 出来。

### 2. Redis 缩回运行态组件

Redis 保留：

- BullMQ 队列。
- rate limit / token bucket。
- distributed lock / leader election。
- worker heartbeat / current status，TTL 级别。
- job temp cache。
- ClickHouse ingest buffer，可选，短期兜底。

Redis 不再作为历史日志或指标主存储。live log tail 也可以直接查 ClickHouse；如果 admin 需要毫秒级 tail，再补 Redis Stream，不作为第一阶段必需项。

### 3. ClickHouse 单体作为历史观测仓库

ClickHouse 保存：

- backend HTTP request events。
- frontend RUM / Web Vitals / JS error。
- analytics events，用于 DAU、功能使用、转化。
- worker structured logs。
- external API call metadata：DXNet、Diving Fish、LXNS、曲库/封面、远程素材；sdgb-worker 通过通用 worker endpoint 接入。
- job timeline events。
- 聚合后的 materialized views。

当前规模不需要 ClickHouse 集群、Keeper 或 Kafka。单体 ClickHouse 足够覆盖 7-90 天观测数据和 admin/Grafana 查询。

不要放在 Server 5 上。Server 5 同时跑 backend×2 + Mongo；ClickHouse 应放独立小机器或 Server 4 PoC，正式建议独立 `4C / 8G / 200GB+ SSD` 起步。

### 4. raw HTML body 作为 artifact，不进 ClickHouse

当前不保存 raw response body：

- ClickHouse 只保存 `method`、`urlGroup`、`statusCode`、`durationMs`、`bodySize`、`bodyHash`、`artifactKey`、`errorClass`。
- artifact service 已部署在 101 的 `/srv/maimai-observability/artifacts`，可通过 `POST /artifacts/raw-response` 写入 gzip artifact。
- worker/backend 自动 error sample、debug mode、手动 capture 尚未接入；接入前 `artifactKey` 通常为空。

原因：线上 `job_api_logs` 10 万条已经形成 6.96GB 逻辑数据。raw HTML 查询价值低、体积大、隐私风险高，不应当作为常规日志字段。

## 目标形态

```text
frontend
  -> /api/v1/observability/rum
  -> /api/v1/observability/events

backend interceptor
  -> http_requests
  -> structured_logs

worker / sdgb-worker
  -> structured_logs
  -> external_api_calls
  -> job_timeline_events

Observability ingest service
  -> batch insert ClickHouse
  -> optional Redis ingest buffer
  -> artifact storage for raw body

admin portal
  -> realtime endpoints from Redis/Mongo current state
  -> history dashboards from ClickHouse
  -> job debug from Mongo + ClickHouse + artifact
```

详细设计见：

- [current-state.md](./current-state.md)
- [realtime-vs-history.md](./realtime-vs-history.md)
- [architecture.md](./architecture.md)
- [clickhouse-schema.md](./clickhouse-schema.md)
- [raw-response-artifacts.md](./raw-response-artifacts.md)
- [dev-testing.md](./dev-testing.md)
- [dashboards-alerts.md](./dashboards-alerts.md)
- [clickhouse-single-node.md](./clickhouse-single-node.md)
- [migration-plan.md](./migration-plan.md)
