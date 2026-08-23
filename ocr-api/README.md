# Score Hub OCR API

独立 FastAPI 服务。接口接收一张或多张完整结算图，只返回识别结果。

## 本地开发

```powershell
$env:OCR_MODE = "real"
$env:OCR_DEVICE = "cuda"
..\scripts\dev\run-ocr-api.ps1
```

生产 pipeline、模型和初始 Cover/Title Gallery 位于 `ocr-api/pipeline/`。
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
OCR_PIPELINE_ROOT=/home/bakapiano/maimai-score-hub-ocr/current/ocr-api/pipeline
OCR_DEVICE=cuda
OCR_API_TOKEN=<shared backend token>
OCR_CATALOG_ENABLED=true
OCR_CATALOG_ROOT=/home/bakapiano/maimai-score-hub-ocr/catalog
OCR_CATALOG_REFRESH_SECONDS=3600
OCR_CATALOG_BUILD_DEVICE=cpu
```

real 模式加载 `OCR_PIPELINE_ROOT/prod_run.py` 的 `build_pipe()`。DX 分数使用现有 `dx_score` anchor，先识别完整文本并提取 `/` 左侧整数；分隔符缺失时识别 crop 左侧 40%。

real 模式运行在 101 的 `bench-venv`。模型二进制通过 Git LFS 管理；torch、ONNX Runtime、Ultralytics、OpenCV 和 PaddleOCR 依赖沿用 GPU 环境。

## 每小时曲库刷新

API lifespan 启动后台任务，每小时运行一次 `pipeline/catalog_refresh.py`：

1. 拉取水鱼 `music_data`，重建 `titles.json`。
2. 将封面缓存到 `OCR_CATALOG_ROOT/covers/`；已有且有效的图片直接复用。
3. 重建 `cover_manifest.json`。
4. 新曲出现时，仅计算新增曲目的 Cover/Title embedding，再分别原子写入两个 Gallery。
5. API 在 Gallery 更新成功后热加载新索引。

Cover 优先取水鱼，随后尝试落雪资源。宴谱复用普通曲目的本地缓存封面。刷新状态通过 `/healthz` 的 `catalog` 字段查看。持久化目录位于 release 目录之外，部署会保留封面缓存与增量 Gallery。

## 部署

推送到 `main` 且改动 `ocr-api/**` 时，`.github/workflows/deploy-ocr.yml` 自动运行测试并部署到 101：

```text
/home/bakapiano/maimai-score-hub-ocr/current/ocr-api
systemd: maimai-score-hub-ocr.service
loopback: 127.0.0.1:19100
```

Actions checkout 会拉取 Git LFS 模型。部署保留最近三个 release，并保留共享的 `catalog/` 运行数据。

部署切换前会使用 `tests/fixtures/84D5CDA37085D5A296BAF14B27C348BD.jpg`
执行真实模型回归，固定验证 `METATRON / 100.8039% / MASTER / SD /
DX Score 2575`。fixture 的 SHA-256 同时由普通单元测试校验。

101 上的 `maimai-score-hub-ocr-tunnel.service` 使用 autossh 将该端口转发到 Server 5 的 Docker host gateway `172.17.0.1:19100`。Backend 容器通过 `http://host.docker.internal:19100` 调用。
