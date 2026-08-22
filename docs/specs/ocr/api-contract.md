# OCR 与成绩更新接口

## OCR API

### `POST /v1/recognize`

Header：

```http
Authorization: Bearer <OCR_API_TOKEN>
Content-Type: multipart/form-data
```

表单字段 `images` 重复出现，每次 1–20 个文件。格式为 JPEG、PNG、WebP，单文件最大 8 MiB。

响应：

```json
{
  "results": [
    {
      "index": 0,
      "filename": "score.jpg",
      "status": "ok",
      "candidates": [
        {
          "title": "METATRON",
          "confidence": 0.9999,
          "sources": ["cover", "title"]
        }
      ],
      "achievement": 100.8039,
      "dxScore": 2575,
      "difficulty": "master",
      "level": "14",
      "isDx": false,
      "fc": null,
      "fs": null,
      "error": null
    }
  ]
}
```

`status`：`ok`、`unrecognized`、`error`。一张图片失败时，同批其他图片继续返回结果。

## Score Hub 图片代理

### `POST /api/v1/me/ocr/recognize`

- 用户 Bearer token。
- multipart 字段与 OCR API 相同。
- backend 校验文件后转发。
- 成功响应使用同一个 `OcrBatchRecognitionResponseSchema`。

主要错误：

| HTTP | 含义 |
| ---: | --- |
| 400 | 图片为空或数量超限 |
| 401 | 用户 token 或 OCR service token 错误 |
| 413 | 单文件超过 8 MiB |
| 415 | 图片格式错误 |
| 502 | OCR response 格式错误 |
| 503 | OCR 服务连接失败 |
| 504 | OCR 服务超过 configured timeout |

## 用户确认后的成绩更新

### `POST /api/v1/me/sync/scores`

前端把启用并校验通过的编辑结果转换为：

```json
{
  "scores": [
    {
      "musicId": "1001",
      "chartIndex": 3,
      "achievement": 100.8039,
      "dxScore": 2575,
      "fc": "fcp",
      "fs": "fs"
    }
  ]
}
```

该接口沿用 `ManualScoreUpdateBodySchema`，单次最多 500 个谱面。backend 按当前曲库解析 music/chart，并使用现有 merge/CAS 规则更新成绩。
