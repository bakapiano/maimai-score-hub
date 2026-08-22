# OCR 导入架构

## 组件

```text
Frontend
  ├─ 拍照：单文件
  ├─ 相册：1–20 文件
  ├─ 编辑/确认识别结果
  └─ 提交批量成绩
       │
       ├─ POST /api/v1/me/ocr/recognize
       ▼
Score Hub backend ── POST /v1/recognize ──► OCR API on 101
       ▲                                      │
       │                                      └─ 只返回识别结果
       │
       └─ POST /api/v1/me/sync/scores
          写入用户确认后的成绩
```

## 职责

### OCR API

- 接收 1–20 张 JPEG、PNG、WebP。
- 每张图片独立返回成功、待确认或错误结果。
- real 模式调用现有 `MaimaiPipeline`。
- 返回曲名候选和成绩字段。

### Score Hub backend

- 使用 `AuthGuard` 验证用户。
- 限制 20 个文件、单文件 8 MiB、单图 40 MP。
- 使用 `OCR_API_TOKEN` 调用 OCR API。
- 校验 OCR response schema并返回前端。
- 通过现有 manual score API 写入已确认结果。

### Frontend

- 选择图片并展示预览。
- 将候选标题映射到当前 `MusicProvider` 曲库。
- 根据 SD/DX 和难度给出默认谱面。
- 允许用户修改所有字段和选择本批次参与更新的条目。
- 校验 DX 分数上限后提交。

## 本地与生产

- 本地：`OCR_MODE=real`，加载 `D:\ocr\ocr\final\pipeline.py`。
- 101：`OCR_MODE=real`，有 `prod_run.py` 时通过 wrapper 构建 pipeline。
- 契约测试：显式使用 `OCR_MODE=fake`，结果不用于模型效果验证。
