# 结算图 OCR 导入

状态：**本地完整链路已实现并通过 E2E**

最后核对：2026-08-22

用户可以拍摄一张结算图，也可以从相册选择多张图片。OCR API 只返回识别结果；前端展示并允许修改每一条结果，用户确认后调用现有批量成绩更新接口。

## 已实现

- 独立服务包：`ocr-api/`。
- 单一批量接口：`POST /v1/recognize`，一次 1–20 张图片。
- Score Hub 代理：`POST /api/v1/me/ocr/recognize`。
- 前端入口：`/app/sync` → “同步成绩” → “图片识别”。
- 可编辑字段：乐曲、难度、达成率、DX 分数、FC、FS。
- 提交接口：`POST /api/v1/me/sync/scores`。
- 本地和 101 使用 real pipeline；fake recognizer 仅用于确定性的契约测试。
- 本地 PM2 全套启动和跨服务 E2E。

## 数据流

```text
图片 → OCR 结果 → 用户确认/修改 → 批量更新成绩 → 刷新最新成绩
```

识别与写入是两次独立请求。OCR 服务接触图片和模型结果；Score Hub backend 负责用户鉴权与成绩更新。

## 本地运行

```powershell
npm run dev:local:start
npm run test:e2e:ocr
```

本地端口：

| 服务 | 地址 |
| --- | --- |
| OCR API | `http://127.0.0.1:19100` |
| Backend | `http://127.0.0.1:9050` |
| Frontend | `http://127.0.0.1:3001` |

## 文档

| 文件 | 内容 |
| --- | --- |
| [current-state.md](current-state.md) | 源码与验证状态 |
| [architecture.md](architecture.md) | 组件与请求链路 |
| [api-contract.md](api-contract.md) | 识别和成绩更新接口 |
| [recognition-pipeline.md](recognition-pipeline.md) | fake/real 识别与 DX 分数处理 |
| [frontend-flow.md](frontend-flow.md) | 拍照、多选、编辑和提交 |
| [operations-and-rollout.md](operations-and-rollout.md) | 本地启动、测试与 101 部署 |
