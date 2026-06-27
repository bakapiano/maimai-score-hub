# 成绩页封面 Sprite Atlas 实验记录

本文档整理 2026-06-27 对 `/app/scores`「按等级」页封面加载优化的实验结果。实验只评估方案，没有改动前端或后端业务代码。

## 背景

当前「按等级」页会把选中等级下所有谱面卡片一次性展开。`MinimalMusicScoreCard` 的封面显示尺寸是 **60x60 CSS px**，但封面源图来自 400x400 WebP/PNG。

在封面缓存命中的情况下，浏览器仍需要为单个等级拉取大量小图。以 13 级为例：

- 466 个谱面卡片
- 456 张唯一封面
- 现有 400px WebP 总体积约 13.63 MiB
- 最坏会产生 456 个封面请求

## 数据来源

| 数据 | 来源 |
| --- | --- |
| 曲目/谱面列表 | 生产 `/api/music` 返回，响应体约 1.18 MiB，曲目数 1350 |
| 封面文件大小 | 生产后端 `backend/covers/*.webp` / `*.png` 本地缓存 |
| Atlas 生成 | 使用生产后端容器内 `sharp`，临时输出到 `/tmp` |
| 浏览器测试 | Playwright Chrome，本地 HTTP server 托管临时 atlas / manifest / covers |

> 注：测试时生产 API 路径与当前源码中的 `/api/v1/...` 存在部署差异；封面体积统计直接读取生产后端本地缓存，避免受 HTTP 路由差异影响。

## 按等级封面规模

排除 `utage` 后共有 1298 首曲目。按等级展开后的规模如下：

| 等级 | 谱面卡片 | 唯一封面 | WebP 总量 | PNG 总量 |
| --- | ---: | ---: | ---: | ---: |
| 15 | 2 | 2 | 0.03 MiB | 0.55 MiB |
| 14+ | 75 | 71 | 2.27 MiB | 21.01 MiB |
| 14 | 194 | 190 | 6.00 MiB | 52.65 MiB |
| 13+ | 350 | 345 | 10.33 MiB | 82.34 MiB |
| 13 | 466 | 456 | 13.63 MiB | 109.55 MiB |
| 12+ | 357 | 353 | 9.82 MiB | 84.35 MiB |
| 12 | 216 | 215 | 6.31 MiB | 53.97 MiB |
| 11+ | 185 | 185 | 5.42 MiB | 44.83 MiB |
| 11 | 195 | 195 | 5.59 MiB | 44.36 MiB |
| 10+ | 225 | 225 | 6.61 MiB | 52.99 MiB |
| 10 | 189 | 189 | 5.83 MiB | 45.06 MiB |
| 9+ | 165 | 165 | 4.40 MiB | 36.39 MiB |
| 9 | 150 | 150 | 4.03 MiB | 36.74 MiB |
| 8+ | 154 | 154 | 4.27 MiB | 38.77 MiB |
| 8 | 271 | 271 | 8.31 MiB | 68.15 MiB |
| 7+ | 306 | 306 | 9.28 MiB | 76.10 MiB |
| 7 | 335 | 335 | 9.48 MiB | 75.53 MiB |
| 6 | 428 | 426 | 12.32 MiB | 101.99 MiB |
| 5 | 336 | 336 | 10.00 MiB | 84.03 MiB |
| 4 | 329 | 329 | 10.06 MiB | 79.52 MiB |
| 3 | 272 | 272 | 7.77 MiB | 61.00 MiB |
| 2 | 112 | 112 | 3.11 MiB | 24.98 MiB |
| 1 | 12 | 12 | 0.23 MiB | 2.50 MiB |

最重等级是 **13**：456 张唯一封面，WebP 约 13.63 MiB。

## Sprite Atlas 体积实验

实验对象：13 级的 456 张唯一封面。

排布方式：近似正方形 atlas，`cols = ceil(sqrt(456)) = 22`，`rows = 21`。

| Tile 尺寸 | Atlas 尺寸 | WebP q75 | WebP q82 | 解码 RGBA 内存 |
| ---: | ---: | ---: | ---: | ---: |
| 60px | 1320x1260 | 0.51 MiB | 0.60 MiB | 6.34 MiB |
| 120px | 2640x2520 | 1.71 MiB | 1.98 MiB | 25.38 MiB |
| 200px | 4400x4200 | 4.22 MiB | 4.91 MiB | 70.50 MiB |

对比现状：

| 方案 | 请求数 | 传输体积 | 解码 RGBA 内存 |
| --- | ---: | ---: | ---: |
| 456 张 400px WebP | 456 | 13.63 MiB | 278.32 MiB |
| 120px q82 atlas | 1 | 1.98 MiB | 25.38 MiB |
| 60px q82 atlas | 1 | 0.60 MiB | 6.34 MiB |

结论：

- Atlas 能显著降低请求数、传输体积和峰值解码内存。
- 当前卡片显示 60x60 CSS px，**120px tile** 能覆盖 DPR 2，体积仍可控。
- **60px tile** 在 DPR 1 下足够，但手机 DPR 2/3 会偏糊。
- **200px tile** 体积仍比现状小，但 atlas 尺寸达到 4400x4200，移动端 GPU texture / 内存风险明显升高。

## 解码与渲染实验

### Desktop Chrome

测试方式：本地 HTTP server 托管同一批 456 张封面、120px atlas、60px atlas；Playwright Chrome 以桌面视口加载。结果为单次实验值，paint 包含创建 466 个 DOM 节点和两个 `requestAnimationFrame`。

| 方案 | 体积 | 解码/加载 | 全部卡片 paint |
| --- | ---: | ---: | ---: |
| 456 张 400px WebP | 14.29 MiB | ~907 ms load | ~2001 ms |
| 120px q82 atlas | 1.98 MiB | ~209 ms decode | ~1791 ms |
| 60px q82 atlas | 0.60 MiB | ~71 ms decode | ~1929 ms |

### Mobile 近似实验

测试方式：Chrome 390x844 viewport、DPR 3、CPU 4x throttle。该结果不是真机测试，只用于粗略判断手机方向。

| 方案 | 解码/加载 | 全部卡片 paint |
| --- | ---: | ---: |
| 456 张 400px WebP | ~681 ms load | ~1800 ms |
| 120px q82 atlas | ~415 ms decode | ~1581 ms |
| 60px q82 atlas | ~126 ms decode | ~1842 ms |

结论：

- Atlas 对网络和 decode 很有效。
- 全量 paint 仍然重，因为仍然一次性创建并绘制 466 个卡片。
- 手机上 atlas 不能单独解决卡顿，必须配合 lazy rendering 或虚拟滚动。

## Demo 结果

临时生成了一个独立 demo 页面：

- 466 个 13 级谱面卡片
- 456 张唯一封面切片
- 所有卡片封面都来自 `level-13-atlas-120-q82.webp`
- 使用 CSS `background-image` + `background-size` + `background-position` 切片
- 包含 60px 紧凑、110px 放大、手机框预览三种模式

Demo 只存放在本次会话临时目录，没有提交到仓库。

## 方案建议

### 不建议

- 不建议做「全曲目全局大 atlas」：
  - 用户只看一个等级时会被迫下载没用到的封面。
  - 单张 atlas 解码内存过大。
  - 不利于 B50、全部成绩、详情页之间复用单封面缓存。
- 不建议移动端直接使用 200px tile：
  - 13 级 atlas 已达 4400x4200。
  - 旧手机可能遇到 GPU texture size 或内存压力。

### 建议路线

1. **先做缩略图基础设施**
   - 为 minimal card 提供 120px WebP 缩略图。
   - 详情页、导出图继续使用原 400px 封面。
   - 即使不做 atlas，也能显著降低传输和 decode 内存。

2. **给按等级页做 per-level atlas**
   - 只对 Level tab 的 minimal card 使用。
   - 推荐默认 `tile=120, quality=82`。
   - 缓存粒度按等级和曲库版本，例如：

   ```text
   GET /api/v1/catalog/cover-atlas/levels/13?tile=120&v=<catalogVersion>
   GET /api/v1/catalog/cover-atlas/levels/13/atlas.webp?tile=120&v=<catalogVersion>
   ```

   manifest 示例：

   ```json
   {
     "tile": 120,
     "width": 2640,
     "height": 2520,
     "atlasUrl": "/api/v1/catalog/cover-atlas/levels/13/atlas.webp?tile=120&v=...",
     "sprites": {
       "100": { "x": 0, "y": 0, "w": 120, "h": 120 }
     }
   }
   ```

3. **必须配合 lazy / virtualized rendering**
   - Atlas 解决请求、传输和 decode。
   - 虚拟滚动或按 detailLevel 分段懒渲染解决 DOM / paint。
   - 移动端优先级更高，因为一次性 paint 466 个卡片仍然明显。

4. **缓存策略**
   - Atlas 和 manifest 使用曲库版本作为 cache key。
   - `Cache-Control: public, max-age=31536000, immutable`。
   - 曲库或封面同步后 bump version，不依赖短 TTL。

## 当前结论

Sprite atlas 对 `/app/scores` 按等级页是可行优化，尤其适合 13、6、13+、12+ 这类单等级 300-450 张封面的场景。推荐实现顺序：

1. 120px thumbnail endpoint / 缓存。
2. Level tab per-level atlas。
3. Level tab lazy / virtualized rendering。

其中 atlas 推荐 **120px q82** 作为首版参数；它在 13 级场景下把 456 个封面请求降为 1 个 atlas 请求，体积从约 13.63 MiB 降到约 1.98 MiB，解码内存从约 278 MiB 降到约 25 MiB。
