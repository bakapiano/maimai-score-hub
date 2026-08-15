# 拍照识曲 API 契约

本文档定义目标契约。字段名在实现 shared contract 时可以做机械调整，但语义和错误边界不得弱化。

## Score Hub 对前端接口

### `POST /api/v1/me/music-recognition`

- 鉴权：现有 Bearer token，挂在 `AuthGuard` 后。
- Content-Type：`multipart/form-data`。

表单字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `image` | file | 是 | JPEG、PNG 或 WebP；首期最大 8 MiB |
| `mode` | string | 是 | `cover`、`title`；保留 `auto` 给完整结算图 |
| `crop` | JSON string | 否 | 原图上的归一化裁剪框，格式见下文 |

`crop` 使用 0 到 1 的归一化值，避免前端压缩或旋转后产生像素坐标歧义：

```json
{
  "x": 0.12,
  "y": 0.28,
  "width": 0.62,
  "height": 0.31
}
```

约束：

- 所有值必须是有限数。
- `x/y >= 0`，`width/height > 0`。
- `x + width <= 1`，`y + height <= 1`。
- crop 应在 EXIF 方向校正后的图像坐标系上解释。

### 成功响应

无法确定曲目也是成功执行，返回 HTTP 200 和 `decision: "no_match"`，不使用 4xx。

```json
{
  "schemaVersion": 1,
  "requestId": "01J...",
  "decision": "confident",
  "modeUsed": "title",
  "ocrText": "Good bye, Merry-Go-Round.",
  "catalogVersion": "2026-07-12T00:00:00Z",
  "modelVersion": "8a4ddd8d3f225ce9",
  "galleryVersion": "catalog-20260712-01",
  "elapsedMs": 286,
  "candidates": [
    {
      "rank": 1,
      "title": "Good bye, Merry-Go-Round.",
      "musicIds": ["11479"],
      "types": ["dx"],
      "coverUrl": "/api/v1/catalog/covers/11479",
      "score": 0.97,
      "signals": {
        "cover": null,
        "title": {
          "cosine": 0.95,
          "margin": 0.42
        },
        "ocr": {
          "text": "Good bye, Merry-Go-Round.",
          "matchScore": 1
        }
      }
    }
  ]
}
```

`decision`：

| 值 | 含义 |
| --- | --- |
| `confident` | 达到已标定的自动推荐阈值；前端高亮 top-1，但仍允许纠正 |
| `needs_confirmation` | 有候选但证据不足或多路冲突；必须由用户选择 |
| `no_match` | 没有可用候选或被判定为 OOD |

`score` 是 OCR 服务融合并标定后的分数，不等于任一模型 softmax `prob`。前端和 Score Hub backend 都不得根据 `signals` 自行重算视觉决策。

`musicIds` 允许为空或包含多个值：

- 空：视觉服务识别出标题，但当前 Score Hub 曲库没有对应记录。
- 多个：同标题存在 SD/DX 或其他重复记录，当前输入没有足够信号消歧。

### 错误响应

| HTTP | `code` | 含义 |
| ---: | --- | --- |
| 400 | `invalid_request` | mode/crop 缺失或格式错误 |
| 401 | `unauthorized` | 用户 token 缺失或无效 |
| 413 | `image_too_large` | 文件或解码后像素超限 |
| 415 | `unsupported_image_type` | MIME/magic bytes 或解码格式不支持 |
| 422 | `invalid_image` | 文件可接收但无法解码、crop 为空或尺寸不可用 |
| 429 | `rate_limited` | 用户/IP 超出配额，携带 `Retry-After` |
| 502 | `ocr_bad_response` | 上游返回不符合内部 schema 的结果 |
| 503 | `ocr_busy` / `ocr_unavailable` | OCR 排队已满或服务不可用 |
| 504 | `ocr_timeout` | 上游超过 deadline |

统一错误结构：

```json
{
  "code": "ocr_busy",
  "message": "识别服务繁忙，请稍后重试",
  "requestId": "01J...",
  "retryAfterSeconds": 2
}
```

## control API 内部接口

### `POST /v1/identify-song`

- 调用方：仅 Score Hub backend 或明确登记的内部服务。
- 鉴权：`Authorization: Bearer <service-token>`。
- 请求：与外部接口相同的 `image/mode/crop`，但图片已经由 Score Hub 标准化。

control API：

1. 校验 service token 和调用方配额。
2. 生成或透传 `X-Request-Id`。
3. 丢弃未知 multipart 字段。
4. 代理到 `127.0.0.1:19000/v1/identify-song`。
5. 不允许借该路径调用完整 `/v1/ocr` 的其他能力。

OCR API 返回的是模型层 schema，不包含 Score Hub 用户或成绩数据：

```json
{
  "schemaVersion": 1,
  "modeUsed": "cover",
  "decision": "confident",
  "modelVersion": "8a4ddd8d3f225ce9",
  "galleryVersion": "catalog-20260712-01",
  "imageSha256": "...",
  "cached": false,
  "elapsedMs": 91,
  "candidates": [
    {
      "rank": 1,
      "title": "Amplifier",
      "score": 0.96
    }
  ],
  "signals": {
    "cover": {
      "topk": [
        {
          "title": "Amplifier",
          "prob": 0.94,
          "cosine": 0.72
        }
      ]
    },
    "title": null,
    "ocr": null
  },
  "quality": {
    "acceptedInput": true,
    "reason": null
  }
}
```

Score Hub 使用 `candidates[].title` 做曲库映射，并透传上游 `decision/score`。`signals` 只用于诊断、指标和可解释展示，不是两套服务之间重复实现融合算法的输入。

## 缓存和幂等

同一请求的模型缓存键：

```text
sha256(normalized image bytes)
+ mode
+ normalized crop
+ modelVersion
+ galleryVersion
```

Score Hub 的曲库解析结果不得只按图像 hash 永久缓存，因为 catalog 会独立更新。若 backend 增加短缓存，必须把 `catalogVersion` 加入键。

服务只缓存识别结果，不缓存原图。日志不得记录图片字节、完整 base64 或 service token。

## shared contract

对前端的响应和错误结构应进入 `shared/src/modules` 并生成 OpenAPI。multipart 文件本身可以沿用当前二维码上传的做法由 controller 处理，但 `mode`、`crop` 和响应必须使用 Zod 校验，避免只在 TypeScript 类型层约束。
