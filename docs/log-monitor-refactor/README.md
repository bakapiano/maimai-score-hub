# Log / Monitor 重构方案总览

本文档给出 admin debug、日志、监控看板和后续 alert 订阅的重构方案。

## 范围与基准

- 用户口径说“线上 master”，但当前仓库没有 `master` / `origin/master`；本地 `origin/HEAD` 指向 `origin/main`。
- 线上 backend `/root/maimai-score-hub-backend/.deploy-revision` 为 `10b887c0ef7149b2fe98dc5c8e588e7ace01f44d`，被本地 `main` 包含；`10b887c..main` 只有部署归档提交，没有业务代码 diff。
- 因此本文把 `main` 作为线上代码基准，把当前工作区 `dev` 里的 Redis 改动视为“已有演进方向，但尚非线上事实”。
- 线上数据来自 2026-06-29 08:45-09:00 Asia/Shanghai 的只读 SSH / `mongosh` 查询；没有使用未验证的推测数字。

## 线上关键事实

### 机器状态

| 节点                       | 角色                                    | 当前状态                                                                                                                     |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Server 5 `175.178.13.169`  | backend×2 + nginx + MongoDB 7           | 2 vCPU / 8GB RAM / 60GB disk；load `0.55 0.45 0.30`；内存 available `4.5GiB`；根盘 `17G/60G`；Mongo 容器 `2.879GiB / 3.5GiB` |
| Server 1 `124.220.225.153` | DXNet worker                            | 2GB RAM；load 接近 0；根盘 `13G/50G`；worker 容器 up 2h                                                                      |
| Server 2 `106.14.237.126`  | DXNet worker + public nginx             | 2GB RAM；available `1.1GiB`；根盘 `18G/40G`；worker 容器 up 4d                                                               |
| Server 4 `192.168.1.101`   | DXNet worker + sdgb-worker + adb-worker | 16GB RAM；available `11GiB`；根盘 `66G/457G`；sdgb-worker up 3d，worker up 9d                                                |
| Server 3 `20.2.80.144`     | frontend                                | 8GB RAM；根盘 `22G/29G`，磁盘偏紧；未取得 docker ps 权限，不作为本方案的服务端容量依据                                       |

### MongoDB 规模

| Collection     |    文档数 | 逻辑大小 | storageSize | 说明                                            |
| -------------- | --------: | -------: | ----------: | ----------------------------------------------- |
| `job_api_logs` |   102,169 |   6.96GB |       953MB | admin job debug 的外部 API 响应体是主要体积来源 |
| `sdgb_jobs`    |    86,870 |  10.50GB |      2.30GB | 24h 内约 86,747 条，TTL 1 天已生效              |
| `worker_logs`  | 1,933,769 |    494MB |       116MB | 控制台日志火力高，且线上 TTL 没生效             |
| `jobs`         |    13,549 |    804MB |       310MB | 7 天 TTL 已生效，业务 source of truth           |
| `syncs`        |     5,958 |    983MB |       248MB | 用户成绩快照，永久数据                          |
| `userentities` |     7,204 |    6.1MB |       3.8MB | 当前用户量基数                                  |

过去 24h 写入量：

| 数据               | 24h 新增 |
| ------------------ | -------: |
| `worker_logs`      |  250,727 |
| `job_api_logs`     |    9,412 |
| `jobs`             |    2,319 |
| `sdgb_jobs`        |   86,747 |
| `auto_update_runs` |      288 |

TTL 漂移：

| Collection     | schema 期望         | 线上实际                              |
| -------------- | ------------------- | ------------------------------------- |
| `worker_logs`  | `ts` 2h TTL         | 无 TTL index；`1,914,194` 条已超过 2h |
| `job_api_logs` | `createdAt` 24h TTL | 无 TTL index；`92,757` 条已超过 24h   |
| `sdgb_jobs`    | `createdAt` 1d TTL  | 已生效                                |
| `jobs`         | `createdAt` 7d TTL  | 已生效                                |

## 技术选型

### 1. MongoDB 继续作为业务状态库

保留 MongoDB 作为下列数据的 source of truth：

- `jobs`、`sdgb_jobs`、`auto_update_runs`、`auto_update_tasks`
- `bot_statuses`、`syncs`、`userentities`
- 后续低频、聚合后的 `monitor_metric_buckets`、`alert_rules`、`alert_events`

原因：

- 这些数据需要按业务字段查询、聚合、回溯和关联，Mongo 当前已经承载了这些模型。
- 线上机器还有可用内存和磁盘，但 Mongo 容器已经接近 3.5GB cap 的 82%；继续塞 raw debug payload 会挤压业务查询。
- 业务表已有 TTL 和索引经验，适合保存“低频事实”和“聚合结果”，不适合保存高频 console line 和大 HTML body。

### 2. Redis 承担短期日志、调试 trace 和运行态计数

新增或沿用当前 `dev` 已出现的 Redis 方向：

- `logs:worker:{kind}`：Redis Stream，按 `MAXLEN` 保留最近 tail。
- `debug:api:{jobId}`：Redis JSON/List，TTL 24h，按 job 保留 API 调用 metadata。
- `monitor:buffer:*`：短窗口计数器/直方图 buffer，由 backend 周期 flush 到 Mongo 聚合桶。
- `status:worker:{kind}:{workerId}`：worker 心跳/最近活跃状态，TTL 级别。

原因：

- 线上 `worker_logs` 24h 约 25 万行，主要用于“看最近发生了什么”，不是长期审计。
- `job_api_logs` 的 debug 价值主要在最近 job；长期保存 raw body 的排障价值低、存储成本高。
- Redis Stream / TTL key 能天然表达 ring buffer 和短生命周期，避免依赖 Mongo TTL index 变更是否成功。
- 当前 Server 5 没有 Redis 容器；部署 Redis 是一个明确的基础设施变更，需要作为 migration step，而不是假设已经存在。

### 3. 不立刻引入 ClickHouse / Loki / Elasticsearch

本阶段不建议上独立日志栈。

原因：

- 当前 raw log 量级是 `worker_logs` 约 25 万行/天、`job_api_logs` 约 9 千条/天，主要痛点不是搜索规模，而是存储边界混乱和 raw body 入库。
- Server 5 是 2C/8G 单机 backend+Mongo，当前 Mongo 已吃到 2.9GB；再塞一套日志栈会增加运维和内存压力。
- 当前需求重点是 admin 看板和可行动 alert，不是 30 天全文检索。

升级触发条件：

- 需要保留 7-30 天 raw console logs 并做全文搜索。
- raw log 写入超过 5M 行/天，或者 Redis Stream tail 无法覆盖排障窗口。
- 需要跨服务 trace 查询、采样、标签聚合，且 Mongo 聚合桶无法支撑。

到那时再评估 ClickHouse 或 Loki；本方案先把事件模型和 ingestion facade 做清楚，后续可以换 sink。

### 4. 大响应体改为按需 artifact

默认不保存 raw `responseBody`：

- API trace 只保存 `method`、`url`、`statusCode`、`durationMs`、`bodySize`、`bodyHash`、`errorClass`、`createdAt`。
- 需要查看 HTML 时，worker 或 backend 可在 debug 开关打开后保存 gzip artifact，TTL 24h，并限制单 job / 全局大小。
- artifact store 初期可以是后端本地 volume；如果后续需要跨机长期保存，再迁到对象存储。

原因：

- `job_api_logs` 当前平均文档约 68KB，线上 10 万条已经形成 6.96GB 逻辑数据。
- 过去 24h top URL 主要是 maimai friend pages，单类 URL 就有 2-3 千万 bytes 级别响应体。
- 大多数 dashboard 和 alert 只需要状态码、耗时、体积、错误分类，不需要 HTML 全文。

## 目标形态

重构后 admin debug 不再是“每类调试信息各自写 API、各自进 DB”，而是统一为：

```text
workers / backend services
  -> ObservabilityModule
       -> logs: recent tail in Redis Stream
       -> traces: per-job short debug trace in Redis
       -> metrics: buffered counters/histograms -> Mongo metric buckets
       -> alerts: rules over metrics/current state -> notification sinks
```

详细设计见：

- [current-state.md](./current-state.md)
- [architecture.md](./architecture.md)
- [dashboards-alerts.md](./dashboards-alerts.md)
- [migration-plan.md](./migration-plan.md)
