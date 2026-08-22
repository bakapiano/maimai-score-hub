# 识别与结果归一化

实现：`ocr-api/app/recognizer.py`

## fake 模式

`FakeRecognizer` 返回稳定的候选和成绩字段，只用于前端、backend 与 Mongo 写入契约 E2E。普通文件名会固定返回 `PANDORA PARADOXXX`，该结果不代表图片识别。

## real 模式

1. 优先从 `OCR_PIPELINE_ROOT/prod_run.py` 导入 `build_pipe()`；本地源码树直接导入 `final.pipeline.MaimaiPipeline`。
2. 启动时加载现有 `MaimaiPipeline` 和 Paddle text recognizer。
3. 每张图片解码为 BGR 并执行完整 pipeline。
4. 合并 `music.topk` 与 `title.topk`，最多返回 3 个去重候选。
5. 提取 achievement、difficulty、level、SD/DX 和 FC。
6. 使用 `dx_score` anchor 识别当前 DX 分数。

## FS 状态

当前 pipeline 的 `fs` anchor 只表示画面中存在 FS 徽章区域。现有 `fc_fs_v1.pt` 与 `fc_2223_2425_v1.pt` 的类别均为 `ap/ap_plus/fc/fc_plus/other`，没有 FS 四分类结果。OCR API 因此返回 `fs: null`，前端由用户手动选择 FS、FS+、FDX 或 FDX+。

## DX 分数

画面格式通常为：

```text
2575/2775 +20
```

处理顺序：

1. 对完整 `dx_score` anchor crop 运行 PaddleOCR。
2. Unicode NFKC、移除空格和千位逗号。
3. 匹配 `当前值/最大值`，返回 `/` 左侧整数。
4. 完整结果缺少分隔符时，对 crop 左侧 40% 再执行一次 OCR。
5. 前端根据已选曲目谱面的 note 总数计算 `maxDxScore` 并校验范围。

实测完整文本 `2575/277` 仍能正确得到当前分数 `2575`；左侧 40% 单独识别结果为 `2575`，置信度 `0.976`。

## 候选排序

- Cover 与 Title top-1 一致时优先该标题。
- 之后按 Cover top-k、Title top-k 的原始顺序去重。
- `confidence` 取同一标题各来源中的最大 `prob`。
- 用户确认是最终选择。
