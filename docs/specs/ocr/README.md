# 拍照识曲 OCR

状态：**方案设计，尚未实现**

最后核对：2026-07-12

本文档组描述 maimai Score Hub 的拍照识曲能力。用户可以拍摄或上传乐曲封面、曲名区域，也可以在后续版本上传完整结算图，由服务返回当前曲库中的候选乐曲。

## 核心结论

- 单图识别是交互请求，使用同步 HTTP POST，不进入现有 DXNet / sdgb worker 队列。
- 浏览器只访问 Score Hub backend；模型继续常驻 101，浏览器不直接访问 101。
- 封面模式以 Cover ArcFace embedding 检索为主。
- 曲名模式同时使用 Title ArcFace 和真正的文字 OCR；纯 OCR 只作为其中一个信号，不单独决定结果。
- OCR 服务负责模型阈值、OOD 和多路融合，返回已标定的 decision、top-k 标题及诊断信号；Score Hub backend 只解析当前曲库 ID、处理同名 SD/DX，并返回面向前端的稳定契约。
- softmax `prob` 不能直接作为可信度。最终决策必须使用 cosine、top1/top2 margin、多路是否一致及离线标定结果。
- 批量相册、离线重跑等长任务才进入 worker；交互请求过载时直接返回 `503 + Retry-After`，不静默转成异步任务。

## 首期范围

首期包含：

1. 已登录用户从成绩页发起“拍照识曲”。
2. `cover` 与 `title` 两种明确的取景模式。
3. 返回最多 3 个候选，用户确认后筛选自己的成绩。
4. 101 上增加面向单图识曲的内部 API。
5. Score Hub backend 增加鉴权、图片校验、限流、上游代理和曲库解析。
6. 曲库与 embedding gallery 的版本同步。

首期不包含：

- 批量相册 OCR。
- 自动导入或修改用户成绩。
- 浏览器端运行模型。
- 把 101 的原始 `/v1/ocr` 直接暴露到公网。
- 对任意自然场景文字提供通用 OCR 服务。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [current-state.md](current-state.md) | 本地 OCR 仓库、101 线上服务、Score Hub 曲库的代码现实与缺口 |
| [architecture.md](architecture.md) | 组件边界、同步 POST 决策、调用链和 worker 使用边界 |
| [api-contract.md](api-contract.md) | 对外与内部接口、请求响应、错误语义及缓存键 |
| [recognition-pipeline.md](recognition-pipeline.md) | 封面、曲名、完整结算图识别与多信号融合 |
| [frontend-flow.md](frontend-flow.md) | 成绩页入口、拍摄/裁剪、候选确认和失败交互 |
| [operations-and-rollout.md](operations-and-rollout.md) | 安全、隐私、指标、图库同步、测试和上线阶段 |

## 术语

| 术语 | 含义 |
| --- | --- |
| Score Hub API | 当前 NestJS backend，对浏览器提供 `/api/v1/*` |
| control API | `maiocr.bakapiano.com` 后的 101 公网门面，通过现有反向隧道访问 |
| OCR API | 101 上模型常驻的 FastAPI，当前监听 `127.0.0.1:19000` |
| gallery | 标题或封面 embedding 及其曲目元数据集合 |
| candidate | 识别返回的候选曲目；一个曲名可能对应多个 `musicId` |
| accepted | 达到标定阈值、可以高亮推荐但仍允许用户纠正的结果 |
