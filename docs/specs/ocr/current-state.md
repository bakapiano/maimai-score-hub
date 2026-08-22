# OCR 当前状态

最后核对：2026-08-22

## 当前仓库

新增 `ocr-api/`，保存 Score Hub 所需的 FastAPI 服务代码：

```text
ocr-api/
  app/
    main.py          # /healthz、/v1/recognize
    recognizer.py    # fake/real recognizer 与结果归一化
    models.py        # API response models
    config.py        # 环境变量
  tests/
  deploy/ocr-api.service
  pyproject.toml
```

相关 Score Hub 代码：

| 部分 | 位置 |
| --- | --- |
| shared response schema | `shared/src/modules/ocr/` |
| backend 代理 | `backend/src/modules/ocr/`、`backend/src/api/me/me-ocr.controller.ts` |
| frontend API | `frontend/src/api/scoreOcr.ts` |
| frontend UI | `frontend/src/features/score-ocr/` |
| 跨服务 E2E | `e2e/src/ocr-flow.e2e.test.ts` |

## 模型源码

完整模型 pipeline 位于 `D:\ocr\ocr`，101 对应 `/home/bakapiano/maimai-ocr`。本地实际入口和模型代码为：

- `final/pipeline.py`
- `final/anchors.py`
- `final/tag_ocr.py`
- `final/cover_arcface_pipeline.py`
- `final/title_arcface_pipeline.py`

`D:\ocr\ocr` 当前没有 `prod_run.py`。real 模式在本地直接加载 `final.pipeline.MaimaiPipeline`；部署目录存在 `prod_run.py` 时优先调用其中的 `build_pipe()`。API 包保存服务边界与结果归一化，模型文件仍由 OCR 源码目录提供。

## 已验证行为

- Python API tests：6/6。
- frontend tests：11/11。
- backend OCR service tests：3/3。
- shared、frontend、backend 生产构建通过。
- `npm run dev:local:start` 成功启动 OCR、backend、frontend、worker 和本地依赖。
- `npm run test:e2e:ocr` 完成登录、两图识别、批量成绩更新和 latest 查询；同一测试也已通过 Vite `/api` 代理运行。

本地交互服务默认使用 `OCR_MODE=real`。fake 模式只用于固定输入输出的 HTTP/写入契约 E2E。

从 `datasets/anchors_clean` 三个版本各取 4 张 val 原图执行 real API smoke test，共 12/12 返回不同的真实曲名；结果包含 `METEOR`、`STARTLINER`、`スカーレット警察のゲットーパトロール24時`、`Latent Kingdom` 等。该目录提供 anchor 标注图，当前没有曲名和 DX 分数的文本 ground truth，因此这次验证属于运行检查。

## 真实图片基线

`84D5CDA37085D5A296BAF14B27C348BD.jpg` 在现有 101 pipeline 中识别为：

```text
title=METATRON
achievement=100.8039
difficulty=master
isDx=false
dxScore=2575
```

DX 分数的完整 PaddleOCR 文本为 `2575/277`；API 提取 `/` 左侧的当前分数 `2575`。分隔符缺失时使用 anchor crop 左侧 40% 再识别。
