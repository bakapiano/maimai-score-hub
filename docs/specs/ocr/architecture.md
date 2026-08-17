# 拍照识曲架构

## 设计目标

- 用户拍照后在一次交互请求内获得候选，正常热路径应在秒级内完成。
- GPU 模型只在 101 常驻一份，Score Hub backend 不加载 Python/ONNX 模型。
- 浏览器不持有 101 的服务凭证，也不依赖家庭 LAN 地址或反向隧道细节。
- Score Hub 曲库是 `musicId`、类型、封面 URL 等产品数据的最终权威来源。
- 模型忙、服务断开或无法识别时明确失败，不产生后台悬挂任务。

## 组件图

```text
Browser / PWA
  │ POST /api/v1/me/music-recognition
  │ Bearer user token + multipart image
  ▼
Score Hub backend
  ├─ 用户鉴权 / rate limit
  ├─ MIME、大小、像素检查
  ├─ sharp 旋转、缩放、去 EXIF
  ├─ 调用上游并设置 deadline
  └─ 将已融合的 title 候选解析成当前曲库 musicIds
  │
  │ POST https://maiocr.bakapiano.com/v1/identify-song
  │ service token + normalized image
  ▼
101 control API（现有反向隧道的公网门面）
  ├─ service token 校验
  ├─ 调用方配额 / request id
  └─ 只代理允许的识曲字段
  │ POST http://127.0.0.1:19000/v1/identify-song
  ▼
101 OCR API
  ├─ 常驻 Cover / Title / OCR 模型
  ├─ 有界等待 + Semaphore
  ├─ SHA-256 + model/gallery version 缓存
  └─ 返回 calibrated decision、top-k title 和诊断 signals
```

## 为什么使用同步 POST

单图识曲的热模型计算是短交互，不满足引入持久任务队列的收益条件。

同步 POST 的优势：

- 前端无需创建 job、轮询、取消或清理过期任务。
- 不增加 MongoDB/BullMQ 状态和失败恢复分支。
- 用户离开页面时可以直接取消 HTTP 请求。
- 现有 OCR API 已经具备常驻模型、结果缓存和 Semaphore。
- 上游过载可以通过标准 HTTP 状态显式反馈。

同步不等于无限等待。OCR API 必须使用有界并发与有界排队；队列已满或等待超时时返回 `503`，并携带 `Retry-After`。

## 调用时序

1. 前端根据模式取得图片和可选 crop。
2. Score Hub backend 校验用户和用户级限流。
3. backend 在内存中解码图片，应用 EXIF 方向，缩小至模型所需分辨率并移除元数据。
4. backend 以 service token 调用 control API。
5. control API 校验调用方并代理到 loopback OCR API。
6. OCR API 按 `mode` 运行直接裁剪分类或完整图 anchor 流程。
7. OCR API 完成 OOD、阈值标定和 cover/title/OCR 融合，返回 decision、canonical title top-k、诊断信号及模型版本。
8. Score Hub backend 使用当前曲库解析标题，保留同名的全部 `musicId`。
9. backend 不重算视觉置信度，只把上游 decision 和候选转换成稳定的产品 schema 后返回前端。

## 超时与背压

首期建议值，需按真实公网链路压测调整：

| 位置 | 目标 |
| --- | --- |
| OCR 模型并发 | 沿用实测 Semaphore，初始上限 6 |
| OCR 等待队列 | 必须有上限；初始建议不超过并发数的 2 倍 |
| Score Hub → control API deadline | 5 秒 |
| 浏览器请求 deadline | 8 秒 |
| 过载响应 | `503`，`Retry-After: 2` 或动态估算 |
| 自动重试 | 默认不自动重试；由用户点击重试 |

连接在请求到达 OCR API 前失败时，Score Hub 可以做最多一次、带剩余 deadline 的快速重试。已经收到上游 HTTP 响应或已经进入模型排队后不重试，避免放大过载。

## Worker 使用边界

以下情况才使用独立 OCR worker/job：

- 相册、目录或报告的一次性批量处理。
- 单次请求包含多张图片，无法保证交互 deadline。
- 需要断点续跑、跨页面查看进度或失败后自动重试。
- 管理员离线重建 gallery、回放 golden set 或重跑历史结果。

批量任务应使用 OCR 自己的 job/worker 域，不复用 DXNet 和 sdgb worker 的业务队列。

首期单图接口不会在超时后自动转为 worker。否则用户可能在未知情况下留下图片和后台任务，且前端无法自然处理迟到结果。

## 服务边界

### Score Hub backend

负责：

- 用户鉴权、用户/IP 限流。
- 图片安全校验与统一编码。
- 101 服务凭证保护。
- 曲库 ID 和封面 URL 解析。
- 面向前端的稳定 schema 和错误语义。

不负责：

- 加载或执行视觉模型。
- 根据 `prob/cosine` 重算模型阈值或融合结果。
- 解释某个模型 checkpoint 的内部类别。
- 保存用户原图。

### 101 OCR 服务

负责：

- 模型加载、预热、并发和缓存。
- cover/title/OCR 原始信号。
- 模型阈值、OOD 拒识和多路融合后的 decision/score。
- 模型及 gallery 版本标识。
- 明确的 OOD/no-match，而不是强制给出某首歌。

不负责：

- Score Hub 用户身份。
- 查询用户成绩。
- 决定前端跳转。
- 直接向浏览器开放 CORS。
