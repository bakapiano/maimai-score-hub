# ClickHouse 单体部署与运维

## 部署目标

第一阶段只上 ClickHouse 单体，不上集群、Keeper、Kafka。

用途：

- 历史 API metrics。
- DAU / analytics events。
- frontend RUM。
- worker structured logs。
- external API calls。
- job timeline。

不承载业务 source of truth，不影响用户同步主链路。

## 机器建议

不要部署在 Server 5。

Server 5 当前已有 backend×2 + nginx + MongoDB，Mongo 容器约 `2.879GiB / 3.5GiB`。ClickHouse 会吃内存和 IO，和 Mongo 混跑风险较高。

建议：

| 阶段 | 机器 |
| --- | --- |
| PoC | Server 4 / 101，2C / 4G / 100GB SSD |
| 正式 | 101 或独立机器，4C / 8G / 200GB+ SSD |
| 后续扩展 | 写入/查询压力明显升高后，再考虑副本、分片、Keeper |

prod/dev 可以共用同一个 101 ClickHouse 实例；所有表必须带 `environment` 字段，admin/Grafana 查询必须显式过滤 `prod` 或 `dev`。详见 [dev-testing.md](./dev-testing.md)。

## Docker Compose 草案

```yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.8
    restart: unless-stopped
    ports:
      - "8123:8123"
      - "9000:9000"
    environment:
      CLICKHOUSE_DB: maimai_observability
      CLICKHOUSE_USER: maimai
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD:?required}
    volumes:
      - clickhouse_data:/var/lib/clickhouse
      - ./config.d:/etc/clickhouse-server/config.d:ro
      - ./users.d:/etc/clickhouse-server/users.d:ro
    ulimits:
      nofile:
        soft: 262144
        hard: 262144

volumes:
  clickhouse_data:
```

生产注意：

- 不公开 8123/9000 到公网；只允许 backend host / admin VPN 访问。
- 固定版本，不追 latest。
- 单独数据盘。
- 配置只读 dashboard 用户和写入用户。

## 写入方式

不要每条 event 一次 insert。

推荐：

```text
backend/worker/frontend
  -> backend observability ingest endpoint
  -> in-memory batch / optional Redis buffer
  -> ClickHouse batch insert every 1-5s or 1000 rows
```

失败策略：

- ClickHouse 短暂不可用：写入 Redis capped buffer 或本地内存短队列。
- buffer 满：丢弃 observability event，记录 self metric；不能阻塞业务主链路。
- alert：insert lag 或 dropped event count 超阈值。

## 保留策略

| 表 | 保留期 |
| --- | --- |
| `structured_logs` | 30d |
| `external_api_calls` | 90d |
| `http_requests` | 180d |
| `frontend_rum` | 180d |
| `job_timeline_events` | 180d |
| `analytics_events` | 365d |
| 聚合 MV | 365d 或更久 |

保留策略用 ClickHouse TTL 表达，并定期检查 TTL 是否生效。

## 备份

最低要求：

- 每日备份 metadata + 最近分区。
- 备份文件同步到另一台机器或对象存储。
- 每月做一次 restore 演练。

因为 ClickHouse 不是业务 source of truth，备份目标可以低于 Mongo，但不能完全没有。丢失历史 analytics 虽不影响业务，但会影响容量判断和事故复盘。

## 监控 ClickHouse 自身

实时监控：

- `/ping`。
- disk free。
- insert error。
- insert lag。
- background merges backlog。
- query duration。
- memory usage。
- table size by database/table。

admin Storage 页面展示：

- 每张表 rows / bytes。
- 最近写入时间。
- TTL 保留期。
- 最大分区。
- dropped events count。

## 运维成本

首次工作：

- 部署 ClickHouse：0.5-1 天。
- 建表和 ingest service：1-2 天。
- 接 backend API metrics / worker external calls：1-2 天。
- 接 frontend RUM / analytics：1-2 天。
- dashboard：1-2 天。

日常：

- 每周看磁盘、insert lag、备份。
- 每月或每季度升级。
- schema 变更走 migration 文件。

## 不做的事

第一阶段不做：

- ClickHouse 集群。
- Keeper。
- Kafka。
- OpenTelemetry 全链路强制接入。
- raw HTML 常规入库。
- 用 ClickHouse 替代 Mongo 业务查询。
