# OCR 当前代码现实

本文档记录 2026-07-12 的检查结果，用于区分已经存在的能力和本方案中的目标能力。线上模型、曲库数量和覆盖率会变化，实施时必须重新核对。

## 本地 `maimai-score-ocr`

本地独立仓库 `D:\maimai-score-ocr` 当前位于 `f027d71`，实际交付是单类封面定位模型：

- `models/cover_single_v5.pt`：从完整成绩图定位主封面。
- held-out 评估为 192/200，即 96% 封面定位成功率。
- `models/classifier.pt`：早期版本分类器，未接入正式 pipeline。
- FastAPI、PaddleOCR、封面识曲和完整字段提取仍是 README 中的规划，不是仓库内实现。
- pHash 封面识别已经放弃，交接记录的实测 top-1 为 0/16。

因此，不能直接把该仓库作为当前 Score Hub 的完整识曲服务部署。

## 101 线上能力

101 上运行的是比本地仓库更后期的代码：

| 项目 | 当前事实 |
| --- | --- |
| 核心模型目录 | `/home/bakapiano/maimai-ocr` |
| 服务目录 | `/home/bakapiano/maimai-ocr-prod` |
| systemd unit | `ocr_api.service` |
| 监听地址 | `127.0.0.1:19000` |
| 运行设备 | CUDA，模型已常驻 |
| 当前接口 | `POST /v1/ocr`、`GET /healthz` |
| 公网门面 | `maiocr.bakapiano.com` 的 `/v1/*` 当前进入 control API，而不是 OCR API |

现有 pipeline 已包含：

- 封面 YOLO 定位。
- Cover ArcFace embedding + cosine gallery 检索。
- Title ArcFace embedding + cosine gallery 检索。
- 版本分类、字段 anchor、分数等专用 OCR/分类器。
- cover/title 多路结果和原始 `prob`、`cosine` 输出。

当前完整 pipeline 的 anchor 模型支持 DX 2020-2021、2022-2023、2024-2025；`maimai_finale` 和网页截图被标记为不支持。直接裁剪识曲不应依赖版本分类和 anchor，从而避免这一限制。

## 线上代码治理缺口

检查时 `/home/bakapiano/maimai-ocr` 与 `/home/bakapiano/maimai-ocr-prod` 都不是 Git 工作树，而本地 `D:\maimai-score-ocr` 又缺少这些后期代码。实施前必须建立唯一源码来源和可复现部署：

1. 将线上核心 pipeline、服务包装和部署文件回收到受版本控制的仓库。
2. 模型文件使用 release、对象存储或模型制品仓库管理。
3. 为每次部署记录 code SHA、model version、gallery version 和 catalog version。
4. 禁止继续只在线上目录直接演进而不回写源码。

## 当前 OCR API 缺口

当前 `/v1/ocr` 面向完整成绩图，不适合作为新功能的直接公开契约：

- 没有 `cover` / `title` 直接裁剪模式。
- 返回完整成绩字段，暴露了新功能不需要的模型细节。
- title 路径是已知曲目的视觉 embedding 检索，不返回真正的 OCR 原文。
- 当前 endpoint 没有显式上传大小和像素限制。
- 当前 endpoint 自身没有调用方鉴权；安全性依赖只监听 loopback。
- 返回标题而不是 Score Hub 的稳定 `musicId`。

新功能应增加独立的 `/v1/identify-song`，保留 `/v1/ocr` 给现有批量成绩识别流程。

## 曲库与 gallery 覆盖

2026-07-12 快照：

| 数据 | 数量 |
| --- | ---: |
| Score Hub 曲库行数 | 1350 |
| Score Hub 唯一非空曲名 | 1293 |
| Cover gallery 曲名 | 1255 |
| Title gallery 曲名 | 1255 |
| gallery 与 Score Hub 精确重合曲名 | 1247 |
| Score Hub 存在但 gallery 缺失 | 46 |
| gallery 存在但 Score Hub 缺失 | 8 |
| Score Hub 同名双记录组 | 57 |

当前精确曲名覆盖约为 96.4%，不能视为完整覆盖。新增歌曲必须能够在不重新部署整个应用的情况下更新 gallery。

57 组同名记录主要来自 SD/DX 等不同记录。视觉服务只返回一个 `title` 时无法稳定确定唯一 ID，因此对外候选必须使用 `musicIds: string[]`。只有完整结算图提供可信 `isDx` 信号时，才可以进一步消歧。

## Score Hub 当前接入点

- 浏览器通过 `MusicProvider` 已持有完整曲库及 `musicMap`。
- “全部成绩”已有曲名/`musicId` 搜索框，是首期相机入口的最小改动位置。
- backend 已使用 NestJS `FileInterceptor` 处理二维码图片上传，并已依赖 `sharp`，可以复用其图片解码与归一化能力。
- `/api/v1/me/*` 已由 `AuthGuard` 保护，适合放置按用户限流的识曲入口。
- 当前 backend 没有通用 HTTP rate-limit 模块，新接口需要单独补充。
