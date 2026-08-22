# 本地运行与 101 部署

## 本地全套

本地默认加载 `D:\ocr\ocr` 的真实模型环境，并把 `ocr-api/` 安装到该环境：

```powershell
npm run dev:local:start
```

OCR 服务已加入：

- `ecosystem.local-dev.config.cjs`
- `.vscode/tasks.json` 的 `dev:all`
- `scripts/dev/start-local.ps1`
- `scripts/dev/status-local.ps1`
- `scripts/dev/stop-local.ps1`

状态检查：

```powershell
npm run dev:local:status
curl http://127.0.0.1:19100/healthz
```

## 测试

```powershell
# OCR API
ocr-api\.venv\Scripts\python.exe -m unittest discover -s ocr-api\tests -v

# Frontend model/UI build
npm --prefix frontend run test
npm --prefix frontend run build

# Backend OCR proxy
npm --prefix backend run typecheck
npm --prefix backend run lint:check

# 全链路
npm run test:e2e:ocr
```

E2E 使用真实 frontend Vite proxy、backend、Mongo、OCR HTTP 和 manual score update API；流程为登录、两图识别、批量写入、latest 验证。

Backend 每次调用 OCR upstream 后记录 `ocr_recognition_usage` 结构化日志，字段包含 `requestCount`、`imageCount`、`recognizedCount`、`outcome`、`userId` 和 `durationMs`。日志不包含图片、文件名或识别文本；按该事件计数即可统计调用次数。

## 配置

本地默认值：

```env
OCR_MODE=real
OCR_API_URL=http://127.0.0.1:19100
OCR_API_TOKEN=change-me-local-ocr
OCR_API_TIMEOUT_MS=180000
OCR_PIPELINE_ROOT=D:\ocr\ocr
OCR_PYTHON=D:\ocr\ocr\.venv\Scripts\python.exe
OCR_DEVICE=cuda
```

101 real 模式：

```env
OCR_MODE=real
OCR_PIPELINE_ROOT=/home/bakapiano/maimai-ocr
OCR_DEVICE=cuda
OCR_API_TOKEN=<random shared token>
OCR_MAX_FILES=20
OCR_CONCURRENCY=2
```

systemd 示例位于 `ocr-api/deploy/ocr-api.service`。101 部署保留现有模型目录与 runtime env。

## Server 5 到 101

生产 backend 设置：

```env
OCR_API_URL=http://host.docker.internal:19100
OCR_API_TOKEN=<same shared token>
OCR_API_TIMEOUT_MS=180000
```

101 服务监听 loopback `127.0.0.1:19100`。`maimai-score-hub-ocr-tunnel.service` 使用专用受限 SSH 用户，将端口反向转发到 Server 5 的 `172.17.0.1:19100`；该地址只属于 Docker host gateway。autossh 配置连接超时 10 秒、每 30 秒 keepalive、连续 3 次无响应后重连，systemd 负责持续拉起。

## 自动部署

`.github/workflows/deploy-ocr.yml` 在 `main` 的 `ocr-api/**` 发生变更时自动触发，也支持手动运行。Workflow 使用 Worker 3 的 SSH secrets 上传 API 源码，保留 101 上的模型目录和 host-only tunnel key，完成测试、服务重启和 real-mode 健康检查。

## 部署顺序

1. OCR workflow 部署 101 并检查 `/healthz`。
2. 确认 Server 5 Backend 容器可访问 SSH tunnel。
3. 使用共享 token 调用 `/v1/recognize`。
4. 部署 backend。
5. 部署 frontend。
