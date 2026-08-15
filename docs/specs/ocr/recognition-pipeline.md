# 识别管线与结果融合

## 总体原则

“识别是哪首歌”是封闭曲库检索问题，不应退化成单一通用 OCR 问题。封面视觉、曲名视觉和 OCR 文本是三路独立信号：

```text
normalized image + optional crop
  ├─ cover crop ── Cover ArcFace ── cosine gallery top-k
  ├─ title crop ── Title ArcFace ── cosine gallery top-k
  └─ title crop ── text OCR ─────── normalized text / catalog match
                                      │
                                      ▼
                           calibrated fusion + OOD reject
                                      │
                                      ▼
                         canonical title + musicIds[] candidates
```

## 通用预处理

Score Hub backend 做安全和传输层标准化；OCR API 做模型层标准化。两层职责不同，不应只保留其中一层。

backend：

1. 使用 magic bytes 和真实解码结果校验类型，不只信任上传的 Content-Type。
2. 应用 EXIF orientation。
3. 转换为 sRGB，并移除 EXIF、GPS、缩略图等元数据。
4. 限制最大像素数，首期建议 16 MP。
5. 将最长边缩小到不超过 1600-2048 px；具体值通过拍照集验证。
6. 编码为稳定 JPEG/WebP 后发送 101。

OCR API：

1. 根据已校正图片解释 crop。
2. 检查 crop 最小宽高、长宽比和有效像素。
3. 按模型 checkpoint 的输入尺寸缩放、归一化。
4. 保留原始 SHA、mode、版本信息用于结果缓存。

## `cover` 模式

首选路径：前端提供用户确认过的方形/近方形 crop，OCR API 直接调用 `CoverArcFacePipeline.classify_crop`。

直接 crop 的好处：

- 不依赖成绩图版本分类。
- 不依赖封面 YOLO 是否见过当前拍摄布局。
- 支持用户只拍封面的场景。
- 计算量和延迟小于完整 pipeline。

当没有 crop 时：

1. 可以用 `cover_single_v5` 尝试在完整图片中定位封面。
2. 找不到封面时返回 `no_match`，不能默认截取中心区域后强制分类。
3. YOLO 检出多个框时采用模型定义的主封面规则，并把定位置信度纳入 quality signal。

输出至少包含 top-3 的 `title/prob/cosine`。`prob` 仅用于诊断，最终产品决策不能只看 `prob`。

## `title` 模式

首选路径：前端提供横向 title crop，同时执行：

1. Title ArcFace embedding 检索。
2. 文字 OCR recognition。
3. OCR 文本标准化和曲库/别名匹配。

Title ArcFace 是主视觉信号，适合艺术字、日文、符号和屏摄噪声。文字 OCR 提供：

- 用户可见的 `ocrText`。
- gallery 尚未覆盖的新歌候选。
- 与 Title ArcFace 相互验证的第二信号。
- 后续与别名搜索共用的文本归一化能力。

title 模式的 OCR 模型必须在进程启动时预热。当前完整 pipeline 中 Paddle fallback 的冷启动可能达到秒级，不能在首个交互请求里 lazy load。

文本标准化至少包括：

- Unicode NFKC。
- trim 和连续空白合并。
- ASCII 大小写 casefold。
- 全角/半角标点的可控映射。
- 保留有辨识度的符号；不得简单删除所有标点。
- canonical title 精确匹配优先，其次 alias，再次才是模糊匹配。

模糊匹配必须返回 top-k 和距离，不得在低分时强行选择最相近曲名。

## `auto` 模式

`auto` 面向完整结算图，不是首期相机 UI 的默认选项。

1. 运行版本分类和对应 anchor detector。
2. 从 `music_cover` 与 `music_title` anchor 分别裁剪。
3. cover/title embedding 可以并行。
4. 当两路一致时通常无需运行较重的通用 OCR。
5. 两路冲突或标题信号偏弱时，再运行文字 OCR 作为消歧。
6. 完整图中的 `music_is_dx` / touch 信号只用于 SD/DX tie-break，不参与曲名本身判断。

Finale、网页截图或未见布局如果无法取得可靠 anchor，应返回 OOD/no-match，不得使用错误 crop 继续分类。

## 融合决策

融合、阈值和 OOD 拒识归 OCR API 所有，并随 `modelVersion/galleryVersion` 一起发布。Score Hub backend 只把 canonical title 映射成当前曲库的 `musicIds[]`，不得复制 renderer 规则或根据原始 `prob/cosine` 重算 decision。这样模型升级不会要求同时发布 TypeScript 融合逻辑。

### 不使用单一 softmax `prob`

现有 gallery 规模下，softmax temperature 会让错误候选也出现接近 1 的 `prob`。融合至少需要：

- top-1 cosine。
- top-1 与 top-2 cosine margin。
- cover/title 是否给出相同 canonical title。
- OCR 文本是否精确或高分匹配同一 title。
- crop/anchor 质量和 OOD 判断。

现有 renderer 使用过的 `cover prob >= 0.8`、`title prob >= 0.8`、cover cosine floor 0.45、title cosine floor 0.60、cover strong cosine 0.85，只能作为完整成绩图分布的参考。直接拍封面/曲名的分布不同，必须重新标定，不能原样复制。

### 决策规则方向

高可信：

- cover 与 title 命中同一 canonical title，且任一路达到基本质量阈值。
- Title ArcFace 与 OCR 精确匹配同一 canonical title。
- 单路 cosine 和 margin 同时达到经验证的强阈值，且输入质量合格。

需要确认：

- 只有一路有中等强度候选。
- cover/title 冲突但各自仍有合理候选。
- OCR 只能模糊匹配。
- 同标题映射到多个 `musicId` 且没有可靠类型信号。

无匹配：

- crop 无效、过小、严重模糊或不符合目标长宽比。
- cosine 与 margin 都低。
- 完整图布局被判 OOD。
- 各路冲突且没有足够证据排序。

## 曲库 ID 解析

OCR API 返回 canonical title 和模型信号，Score Hub backend 使用当前曲库生成：

```text
canonical title
  → exact title index
  → zero / one / multiple music rows
  → musicIds[] + types[] + coverUrl
```

直接 crop 无法可靠分辨同标题 SD/DX 时，保留全部 ID。前端按这些 ID 联合筛选，而不是任选一个。

长期建议在 gallery 中增加稳定的 `catalogKeys` 或 `musicIds` 元数据，但 OCR 服务仍需兼容一对多。Title gallery 的同一标题视觉本身不包含 SD/DX 信息，不能通过简单增加两个相同行来解决消歧。

## Gallery 更新

更新 gallery 不应要求重新训练整个 ArcFace backbone：

1. Score Hub 导出带版本的曲库快照和标准封面。
2. 对新增/变更封面生成 embedding。
3. 对新增标题生成或采集 title gallery embedding。
4. 生成不可变 gallery artifact 和 manifest。
5. 离线验证后原子切换 gallery 版本。
6. model/gallery version 变化自动使旧 OCR cache 失效。

新歌如果仅更新曲库而未更新 gallery，文字 OCR 可以提供有限兜底，但不能替代 gallery 同步告警。
