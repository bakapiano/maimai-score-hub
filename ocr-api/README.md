# Score Hub OCR API

独立 FastAPI 服务。接口接收一张或多张完整结算图，只返回识别结果。

## 本地开发

```powershell
$env:OCR_MODE = "real"
$env:OCR_PIPELINE_ROOT = "D:\ocr\ocr"
$env:OCR_DEVICE = "cuda"
..\scripts\dev\run-ocr-api.ps1
```

本地 real 模式使用 `D:\ocr\ocr\.venv`，启动脚本会把本 API 包安装到该环境。需要单独验证 HTTP 契约时可显式设置 `OCR_MODE=fake`。

## 接口

```text
GET  /healthz
POST /v1/recognize  multipart images=<file>, 1..20 files
```

设置 `OCR_API_TOKEN` 后，识别接口要求 `Authorization: Bearer <token>`。

## 101 实际模型

```env
OCR_MODE=real
OCR_PIPELINE_ROOT=/home/bakapiano/maimai-ocr
OCR_DEVICE=cuda
OCR_API_TOKEN=<shared backend token>
```

real 模式优先加载 `OCR_PIPELINE_ROOT/prod_run.py` 的 `build_pipe()`；本地源码树没有该 wrapper 时直接加载 `final/pipeline.py` 的 `MaimaiPipeline`。DX 分数使用现有 `dx_score` anchor，先识别完整文本并提取 `/` 左侧整数；分隔符缺失时识别 crop 左侧 40%。

real 模式运行在 101 现有 `bench-venv`，模型侧的 torch、ONNX Runtime、Ultralytics、OpenCV 和 PaddleOCR 依赖沿用该环境。

## 部署

推送到 `main` 且改动 `ocr-api/**` 时，`.github/workflows/deploy-ocr.yml` 自动运行测试并部署到 101：

```text
/home/bakapiano/maimai-score-hub-ocr/current/ocr-api
systemd: maimai-score-hub-ocr.service
loopback: 127.0.0.1:19100
```

101 上的 `maimai-score-hub-ocr-tunnel.service` 使用 autossh 将该端口转发到 Server 5 的 Docker host gateway `172.17.0.1:19100`。Backend 容器通过 `http://host.docker.internal:19100` 调用。
