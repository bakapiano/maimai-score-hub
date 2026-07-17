# Dev 环境测试方案

本地 Windows dev 可以直接连 101 上的 ClickHouse 和 artifact service。prod/dev 共用同一套观测基础设施是可接受的，因为这些数据不是业务 source of truth；关键是所有写入和查询都必须带 `environment`。

## 拓扑

```text
local Windows dev
  -> backend/frontend/worker local
  -> ClickHouse on 101
  -> artifact service on 101

prod backend/workers
  -> same ClickHouse on 101
  -> same artifact service on 101
```

隔离方式：

- ClickHouse 所有表都有 `environment` 字段。
- local dev 写 `environment='dev'`。
- prod 写 `environment='prod'`。
- admin dashboard 默认查 `prod`，dev dashboard 明确切到 `dev`。
- artifact key 带 `raw-response/dev/...` 或 `raw-response/prod/...` 前缀。
- prod/dev 使用不同 ingest secret，避免误写。

## 101 服务

建议 101 上放：

```text
/srv/maimai-observability/
  clickhouse/
  artifact-service/
  artifacts/
```

ClickHouse 监听：

```text
8123 HTTP
9000 native
```

artifact service 监听：

```text
3901 HTTP
```

如果本机 Windows 到 101 网络直通，本地 `.env` 直接配置：

```text
OBSERVABILITY_ENV=dev
CLICKHOUSE_URL=http://192.168.1.101:8123
CLICKHOUSE_DATABASE=maimai_observability
CLICKHOUSE_USER=maimai_dev_writer
CLICKHOUSE_PASSWORD=...
ARTIFACT_SERVICE_URL=http://192.168.1.101:3901
ARTIFACT_SHARED_SECRET=...
```

prod 使用：

```text
OBSERVABILITY_ENV=prod
CLICKHOUSE_URL=http://192.168.1.101:8123
CLICKHOUSE_USER=maimai_prod_writer
```

## 权限建议

ClickHouse 至少建三个用户：

| 用户 | 用途 |
| --- | --- |
| `maimai_prod_writer` | prod 写入 |
| `maimai_dev_writer` | dev 写入 |
| `maimai_readonly` | admin/Grafana 查询 |

第一阶段可以不做行级权限，但应用层必须强制带 `environment`。后续如果担心误查，可以再加 ClickHouse row policy。

## 本地验证步骤

### 1. 连通性

```powershell
curl http://192.168.1.101:8123/ping
curl http://192.168.1.101:3901/health
```

ClickHouse 应返回：

```text
Ok.
```

### Windows dev 连接 ClickHouse 配置

本地 backend 负责把 frontend / worker 上报的数据批量写入 ClickHouse；
frontend 和 worker 不直接连接 ClickHouse。

`backend/.env` 建议：

```text
OBSERVABILITY_ENABLED=true
OBSERVABILITY_ENV=dev
OBSERVABILITY_INSTANCE=local-backend
CLICKHOUSE_URL=http://192.168.1.101:8123
CLICKHOUSE_DATABASE=maimai_observability
CLICKHOUSE_USER=maimai_dev_writer
CLICKHOUSE_PASSWORD=<dev writer password>
CLICKHOUSE_FLUSH_INTERVAL_MS=3000
CLICKHOUSE_MAX_BATCH_ROWS=1000
CLICKHOUSE_MAX_BUFFERED_ROWS=50000
```

`worker/.env` 只需要连本地 backend：

```text
NODE_ENV=dev
WORKER_ID=dxnet-worker-local
JOB_SERVICE_BASE_URL=http://127.0.0.1:9050/
API_SHARED_SECRET=<same as backend API_SHARED_SECRET or ADMIN_PASSWORD>
```

如果 Windows 到 `192.168.1.101:8123` 不直通，可以先开 SSH tunnel：

```powershell
ssh -N -L 8123:127.0.0.1:8123 bakapiano@192.168.1.101
```

然后把 backend 改成：

```text
CLICKHOUSE_URL=http://127.0.0.1:8123
```

验证当前 backend 写入状态：

```powershell
curl -H "x-api-secret: <secret>" http://127.0.0.1:9050/api/v1/admin/observability/status
```

返回里 `clickhouse.ping=true` 表示连接正常；`bufferedRows` 会在 flush
间隔内短暂大于 0，`droppedRows` 应保持 0。

### 2. 建表

只在 101 上执行一次 [clickhouse-schema.md](./clickhouse-schema.md) 的 DDL。

本地验证：

```powershell
curl "http://192.168.1.101:8123/?query=SHOW%20TABLES%20FROM%20maimai_observability"
```

### 3. 本地 backend 写入 `http_requests`

启动 local backend，设置：

```text
OBSERVABILITY_ENV=dev
OBSERVABILITY_ENABLED=true
```

请求几个 API 后查：

```sql
SELECT environment, routeTemplate, count()
FROM maimai_observability.http_requests
WHERE environment = 'dev'
  AND ts >= now() - INTERVAL 10 MINUTE
GROUP BY environment, routeTemplate;
```

### 4. 本地 frontend 写入 RUM / analytics

打开本地 frontend，登录并访问页面。查询：

```sql
SELECT environment, eventName, count()
FROM maimai_observability.analytics_events
WHERE environment = 'dev'
  AND ts >= now() - INTERVAL 10 MINUTE
GROUP BY environment, eventName;
```

```sql
SELECT environment, routeTemplate, count(), quantile(0.95)(loadMs)
FROM maimai_observability.frontend_rum
WHERE environment = 'dev'
  AND ts >= now() - INTERVAL 10 MINUTE
GROUP BY environment, routeTemplate;
```

### 5. 本地 worker 写入 external API metadata

用一个测试 job 或 mock external call 写入：

```sql
SELECT environment, target, apiGroup, statusCode, count()
FROM maimai_observability.external_api_calls
WHERE environment = 'dev'
  AND ts >= now() - INTERVAL 10 MINUTE
GROUP BY environment, target, apiGroup, statusCode;
```

### 6. artifact 写入

触发一个 error response 或强制 debug capture，确认返回 `artifactKey`：

```text
raw-response/dev/YYYY/MM/DD/job_<jobId>/...
```

101 上确认文件存在：

```bash
find /srv/maimai-observability/artifacts/raw-response/dev -type f | tail
```

admin 读取时必须带 dev environment，不能默认读 prod artifact。

## Dashboard 测试

admin History 页面加 environment selector：

- 默认：`prod`
- 可切换：`dev`

开发时看 dev 数据：

```text
/admin/history?env=dev
/admin/jobs/<jobId>/debug?env=dev
```

所有 ClickHouse 查询都必须包含：

```sql
WHERE environment = {environment:String}
```

## 清理 dev 数据

dev 数据可以短保留，避免污染长期历史。

第一阶段简单做法：

- 所有表共用 TTL。
- dev 数据量小，无需单独清理。

如果 dev 噪音变多，再加定期清理：

```sql
ALTER TABLE http_requests DELETE WHERE environment = 'dev' AND ts < now() - INTERVAL 7 DAY;
ALTER TABLE frontend_rum DELETE WHERE environment = 'dev' AND ts < now() - INTERVAL 7 DAY;
ALTER TABLE analytics_events DELETE WHERE environment = 'dev' AND ts < now() - INTERVAL 30 DAY;
ALTER TABLE structured_logs DELETE WHERE environment = 'dev' AND ts < now() - INTERVAL 7 DAY;
ALTER TABLE external_api_calls DELETE WHERE environment = 'dev' AND ts < now() - INTERVAL 7 DAY;
ALTER TABLE job_timeline_events DELETE WHERE environment = 'dev' AND ts < now() - INTERVAL 7 DAY;
```

## 风险和约束

prod/dev 共用 ClickHouse 的风险主要是“查询忘记过滤 environment”和“dev 写太多”。约束：

- ingest DTO 必须要求 `environment`。
- backend 根据 `OBSERVABILITY_ENV` 注入 environment，不信任前端直接传 prod/dev。
- admin 所有历史查询必须显式接收 `environment`，默认 prod。
- dev 成功 raw response 采样率可以比 prod 更高，但要限制总量。
- prod/dev 使用不同 writer secret。
