# Raw Response Artifact 存储方案

raw HTML / large JSON response 不进 Mongo，也不进 ClickHouse。ClickHouse 只保存 metadata 和 `artifactKey`；原始响应体作为 gzip artifact 短期落盘。

## 当前实现状态

已实现：

- 101 上的 artifact service。
- `POST /artifacts/raw-response` 写 gzip 文件。
- `GET /artifacts/{artifactKey}` 读取 gzip 文件。
- shared secret 鉴权、路径前缀校验、body 大小限制、TTL/容量清理。

尚未接入：

- DXNet worker / backend 自动保存 error response。
- 成功响应采样。
- admin 临时 debug capture 开关。
- admin artifact viewer UI。

因此当前 ClickHouse `external_api_calls.artifactKey` 字段只有调用方显式传入时才会有值；正常 worker 外部调用 metadata 目前只写 `bodySize` / `errorClass` 等字段。

## 保存条件

保存 raw response 的目标是排障，不是长期统计。

默认保存：

- statusCode >= 400。
- DXNet 567。
- 空响应 / 解析失败。
- cookie expired / login required。
- job 最终 failed。

成功响应采样保存：

- 默认 `1%`。
- 可按 `urlGroup` 调整，例如 `maimai.friend.genre_vs` 采样低一些，`maimai.friend.invite` 采样高一些。
- admin 可临时开启某个 `jobId` / `workerId` / `botFriendCode` 的 debug capture，窗口 10-30 分钟。

不保存：

- 请求/响应 header 中的 cookie、authorization、secret。
- QR raw payload。
- OAuth/recovery 完整 URL。
- 明文 token。

## 存储位置

用户希望放在 101 机器上，因为空间更大。

建议路径：

```text
101 host:
  /srv/maimai-observability/artifacts/

inside artifact service:
  /data/artifacts/
```

101 当前根盘约 `457G`，已用约 `66G`，适合承载短期 debug artifact。不要放在 Server 5，因为 Server 5 同时跑 backend 和 Mongo，且只有 60GB 根盘。

## 目录结构

```text
/srv/maimai-observability/artifacts/
  raw-response/
    prod/
      2026/
        06/
          29/
            job_<jobId>/
              000001_maimai.friend.pages_200_a13f9c2e.html.gz
              000002_maimai.friend.genre_vs_567_91ab02cd.html.gz
    dev/
      2026/
        06/
          29/
            job_<jobId>/
              000001_maimai.friend.pages_200_a13f9c2e.html.gz
```

文件名规则：

```text
{seq}_{urlGroup}_{statusCode}_{bodyHashPrefix}.{ext}.gz
```

约束：

- 不使用原始 URL 作为文件名。
- `urlGroup` 只允许 `[a-z0-9._-]`。
- `jobId` 只允许安全字符。
- `ext` 为 `html` / `json` / `txt`。
- `artifactKey` 是相对路径，不是绝对路径。
- `artifactKey` 必须带 environment 前缀，例如 `raw-response/prod/` 或 `raw-response/dev/`。

ClickHouse `external_api_calls.artifactKey` 示例：

```text
raw-response/prod/2026/06/29/job_abc/000002_maimai.friend.genre_vs_567_91ab02cd.html.gz
```

## 写入方式

推荐新增一个只在 101 内网暴露的 artifact service。

```text
worker / backend
  -> POST http://101-lan:PORT/artifacts/raw-response
  -> artifact service 写入 /srv/maimai-observability/artifacts
  -> 返回 artifactKey
  -> worker/backend 上报 external_api_calls 到 ClickHouse
```

不建议让每个 worker 直接写 101 文件系统：

- Server 1/2 到 101 跨网络，直接挂 NFS/SSHFS 不稳定。
- artifact service 可以统一做鉴权、大小限制、gzip、路径校验、TTL 清理。
- backend/admin 读取也能走同一个服务。

artifact service 最小接口：

```http
POST /artifacts/raw-response
Authorization: Bearer <ARTIFACT_SHARED_SECRET>
Content-Type: application/json

{
  "jobId": "...",
  "environment": "prod",
  "workerId": "...",
  "botFriendCode": "...",
  "urlGroup": "maimai.friend.pages",
  "statusCode": 200,
  "contentType": "text/html",
  "bodyBase64": "...",
  "bodyHash": "sha256:...",
  "createdAt": "2026-06-29T10:00:00.000+08:00"
}
```

响应：

```json
{
  "artifactKey": "raw-response/prod/2026/06/29/job_abc/000001_maimai.friend.pages_200_a13f9c2e.html.gz",
  "storedBytes": 12345,
  "bodyHash": "sha256:..."
}
```

如果 body 太大或不满足采样条件，返回：

```json
{
  "artifactKey": null,
  "skipped": true,
  "reason": "body_too_large"
}
```

## 读取方式

admin 不直接暴露 artifact 静态目录。

推荐：

```text
admin portal
  -> backend GET /api/v1/admin/artifacts/:artifactKey
  -> backend 校验 admin secret
  -> backend 向 101 artifact service 拉取
  -> 返回 text/html 或 text/plain
```

artifact service 读取接口：

```http
GET /artifacts/{artifactKey}
Authorization: Bearer <ARTIFACT_SHARED_SECRET>
```

backend 必须校验：

- `artifactKey` 不能包含 `..`。
- resolved path 必须在 artifacts root 下。
- 只允许读取已知 prefix，例如 `raw-response/prod/` 或 `raw-response/dev/`。

前端预览：

- HTML 用 sandbox iframe。
- 默认展示 source，点击后再 render。
- 不执行脚本，iframe sandbox 不给 `allow-scripts`。

## 大小与 TTL

建议初始配置：

```text
ARTIFACT_ROOT=/srv/maimai-observability/artifacts
RAW_RESPONSE_DEFAULT_TTL_HOURS=24
RAW_RESPONSE_ERROR_TTL_DAYS=7
RAW_RESPONSE_SUCCESS_SAMPLE_RATE=0.01
RAW_RESPONSE_MAX_BODY_BYTES=2097152
RAW_RESPONSE_MAX_JOB_BYTES=20971520
RAW_RESPONSE_MAX_TOTAL_BYTES=21474836480
```

解释：

- 单个 body 最大 2MB。
- 单个 job 最大 20MB。
- artifact 总量上限 20GB。
- 成功采样 1%。
- 错误保留 7 天，普通采样 24h。

TTL 清理：

- artifact service 每 10 分钟扫描一次 metadata。
- 优先删过期文件。
- 如果总量超过上限，按 oldest first 删除。
- 删除后不改 ClickHouse；admin 查到 artifact 不存在时显示 expired。

## metadata

为了清理和排查，101 本地保存轻量 metadata。

可以用 SQLite：

```sql
CREATE TABLE artifacts (
  artifactKey TEXT PRIMARY KEY,
  environment TEXT,
  jobId TEXT,
  workerId TEXT,
  botFriendCode TEXT,
  urlGroup TEXT,
  statusCode INTEGER,
  bodyHash TEXT,
  contentType TEXT,
  storedBytes INTEGER,
  createdAt TEXT,
  expiresAt TEXT
);
```

也可以用 plain JSON sidecar，但 SQLite 更利于 TTL 和总量统计。

## 失败策略

- artifact service 不可用：不阻塞 job，`artifactKey = null`，ClickHouse 仍记录 metadata。
- 写入超时：丢弃 raw body，记录 `artifactSkippedReason`。
- 磁盘满：停止保存 artifact，触发 alert。
- ClickHouse 不可用：artifact 可以保存，但 external API metadata 可能丢；业务仍继续。

## 部署位置

101 上建议单独目录：

```text
/srv/maimai-observability/
  artifact-service/
  artifacts/
  docker-compose.yml
```

如果 artifact service 用 Docker：

```yaml
services:
  artifact-service:
    image: maimai-artifact-service:latest
    restart: unless-stopped
    environment:
      ARTIFACT_ROOT: /data/artifacts
      ARTIFACT_SHARED_SECRET: ${ARTIFACT_SHARED_SECRET:?required}
      RAW_RESPONSE_SUCCESS_SAMPLE_RATE: "0.01"
      RAW_RESPONSE_MAX_TOTAL_BYTES: "21474836480"
    volumes:
      - /srv/maimai-observability/artifacts:/data/artifacts
    ports:
      - "127.0.0.1:3901:3901"
```

101 没有公网入口。backend 如果需要访问 artifact service，可以通过：

- 101 -> Server 2 reverse tunnel，或
- Server 5 到 101 的内网/VPN/tunnel，或
- 先让 worker 只上传 artifact metadata，admin 从 101 内网访问时读取。

正式推荐加一条受限反向隧道，只暴露 artifact service 到 Server 5 可访问的地址，并用 shared secret 鉴权。
