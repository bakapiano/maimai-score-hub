# 前端交互

实现：`frontend/src/features/score-ocr/`

## 入口

`/app/sync` 的“同步成绩”卡片提供第三种同步方式“图片识别”。选中后显示两个按钮：

- `拍照识别`：原生文件 input，`capture="environment"`，单图。
- `相册批量识别`：原生文件 input，`multiple`，最多 20 图。

入口统一位于同步页；成绩为空时，成绩页继续链接到 `/app/sync`。

## 流程

```text
选择图片
  → 上传并识别
  → 每张图生成一张编辑卡
  → 用户检查或修改
  → 选择参与更新的条目
  → 确认并更新成绩
  → 刷新 latest scores
```

## 编辑卡

每张卡显示图片预览、文件名、OCR 候选和以下控件：

- 当前所选乐曲的封面；改选乐曲后同步更新。
- 乐曲：当前曲库 searchable Select。
- 难度：Basic、Advanced、Expert、Master、Re:Master、Utage。
- 达成率：0–101，四位小数。
- DX 分数：非负整数，并显示当前谱面上限。
- FC：FC、FC+、AP、AP+。
- FS：FS、FS+、FDX、FDX+。
- 更新 Checkbox。

默认乐曲按候选标题精确匹配，并使用 OCR 的 `isDx` 选择 SD/DX 记录。用户可以覆盖所有默认值。

## 提交校验

- 至少选择一条结果。
- 每条结果已选择乐曲和有效谱面。
- 同一 `musicId + chartIndex` 在批次内唯一。
- 达成率和 DX 分数在有效范围内。
- 每条至少包含 achievement、dxScore、FC、FS 中的一项。

提交成功后显示更新数量，并刷新同步页的最近同步记录。
