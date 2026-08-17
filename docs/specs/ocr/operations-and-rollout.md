# OCR 运行、安全与上线

## 上线前置条件

以下项目完成前不应向用户开放入口：

1. 101 当前核心代码和服务包装进入 Git，部署可由固定 revision 重现。
2. 模型与 gallery 有 manifest、checksum 和不可变版本号。
3. gallery 使用最新 Score Hub 曲库重建，覆盖差异有可观测指标。
4. control API 的新 endpoint 有 service token 校验。
5. Score Hub endpoint 有图片限制、用户/IP 限流和上游 deadline。
6. 至少完成一轮真实手机拍摄数据的阈值标定。

## 图片安全与隐私

### 接收限制

首期建议：

| 项目 | 限制 |
| --- | --- |
| 编码文件大小 | 8 MiB |
| 解码像素 | 16 MP |
| 类型 | JPEG、PNG、WebP |
| 单请求文件数 | 1 |
| 动图 | 只允许第一帧或直接拒绝；行为必须固定并测试 |

必须防护：

- MIME spoofing。
- 解压炸弹和异常超大尺寸。
- 损坏图片导致的原生库异常。
- crop 越界、NaN、Infinity。
- 文件名、EXIF 和 ICC profile 中的非预期数据。

### 数据保留

- Score Hub 与 OCR API 默认不落盘原图。
- 标准化图像只在请求内存生命周期内存在。
- OCR cache 保存 hash 和结构化结果，不保存图片字节。
- 日志不记录 OCR service token、原图、base64 或完整 multipart body。
- 原始 OCR 文本可能包含屏幕上的其他内容，默认不进入长期日志。
- 用户主动提交纠错样本时使用独立 consent 和保留策略。

## 鉴权和限流

### 用户侧

`/api/v1/me/music-recognition` 使用现有用户 Bearer token。初始限流建议：

- 每用户 10 次/分钟。
- burst 3。
- 同时结合 IP 维度，防止批量注册绕过。

具体值上线后根据正常重拍次数、GPU 利用率和错误率调整。

### 服务侧

Score Hub 调用 control API 使用独立 service token：

- token 只存服务端 secret/env，不进入前端 bundle。
- control API 只授予 `/v1/identify-song` scope。
- 支持轮换，并允许短时间双 token 过渡。
- nginx、control API 和 OCR API 都不得把 Authorization 写入 access/error log。

OCR API 保持 loopback，不新开公网监听。公网流量继续通过现有 TLS、nginx 和反向隧道进入 control API。

## 可观测性

每个请求使用同一个 `requestId` 贯穿浏览器、Score Hub、control API 和 OCR API。

必须指标：

| 指标 | 维度 |
| --- | --- |
| 请求量 | mode、caller、HTTP status |
| 端到端延迟 | mode、cached、decision |
| 模型延迟 | cover/title/OCR、modelVersion |
| 排队时间 | queue depth、Semaphore wait |
| 结果分布 | confident/needs_confirmation/no_match |
| 用户纠正率 | top-1 selected / other selected / none selected |
| gallery 覆盖 | catalog missing、gallery stale |
| 上游错误 | timeout、busy、decode、bad response |

日志只记录必要结构化字段：

```text
requestId, userHash, mode, bytes, dimensions,
modelVersion, galleryVersion, catalogVersion,
decision, candidateCount, elapsedMs, errorCode
```

`userHash` 使用不可逆、可轮换的服务端散列，不记录用户 token。

## 健康检查和熔断

- OCR API `/healthz` 只有在模型和 gallery 均加载完成后返回 200。
- 增加 deep health 时必须限频，不能让监控持续触发完整 GPU 推理。
- Score Hub 对连续连接失败/超时使用短熔断，熔断期间快速返回 `ocr_unavailable`。
- `503 busy` 不计入服务崩溃熔断，但应触发容量告警。
- 模型加载失败时 systemd 可以重启；不要配置多个 uvicorn worker 重复占用 GPU 显存。

## 测试数据与指标

新取景模式不能直接沿用完整成绩图的旧阈值。上线前至少建立 cover/title 各 200 张的独立测试集，包含：

- 不同手机、方向、距离和压缩质量。
- 屏幕反光、摩尔纹、透视、运动模糊和遮挡。
- 中文、日文、英文、符号和长标题。
- 同名 SD/DX、新歌及 gallery 缺失。
- 非 maimai 图片、错误 crop、双屏和其他 OOD。

最低验收方向：

- `confident` 集合的 top-1 precision 不低于 99%。
- top-3 recall 不低于 98%；需按 cover/title 分开统计。
- OOD 不得因为 softmax 饱和而大量 false accept。
- 热路径端到端 p95 目标小于 2 秒，超时上限不超过 8 秒。
- 服务重启、gallery 切换和缓存失效行为有自动化测试。

precision 优先于 coverage：低置信度返回候选让用户确认，比自信地筛错歌曲更安全。

## 测试分层

1. 单元测试：crop、图片限制、文本归一化、title→musicIds、一对多、融合规则。
2. contract 测试：Score Hub 与 control API 的 multipart、响应 schema、错误映射。
3. 模型 golden：固定图片、checkpoint/gallery version 和预期 top-k。
4. 集成测试：Score Hub 使用 fake OCR upstream，覆盖超时、503、invalid schema。
5. 101 staging：真实 CUDA、并发、缓存、模型重启和 gallery 原子切换。
6. 手机验收：Android Chrome、iOS Safari、PWA、相册和直接拍摄。

## Gallery 同步和发布

建议把 gallery 构建做成独立离线任务：

```text
Score Hub catalog export
  → validate covers/titles
  → generate embeddings
  → compare coverage and duplicates
  → run golden/evaluation
  → publish immutable artifact + manifest
  → 101 preload and atomic switch
```

manifest 至少包含：

```json
{
  "galleryVersion": "catalog-20260712-01",
  "catalogVersion": "2026-07-12T00:00:00Z",
  "modelVersion": "cover-v2+title-v1",
  "titleCount": 1293,
  "sha256": {
    "cover": "...",
    "title": "..."
  }
}
```

发布时先加载并验证新 gallery，再切换引用；不要覆盖正在使用的 `.npz` 文件。旧版本至少保留一个回滚窗口。

## 上线阶段

### Phase 0：收拢代码与制品

- 回收 101 线上代码到 Git。
- 固化模型 manifest 和部署方式。
- 重建当前曲库 gallery，解决已知 46 首缺失和 8 首 stale 快照差异。

### Phase 1：内部同步 API

- OCR API 实现 `/v1/identify-song`。
- control API 实现 service-auth proxy。
- Score Hub 实现受保护的 `/api/v1/me/music-recognition`。
- 使用 fake upstream 完成 contract 和错误路径测试。

### Phase 2：前端灰度

- 在“全部成绩”搜索框加入入口。
- 只对白名单/feature flag 用户开放。
- 收集延迟、no-match、非 top-1 选择率，不保存原图。

### Phase 3：标定与开放

- 使用明确 consent 的失败样本补测试集。
- 标定 cover/title/OCR 融合阈值。
- 达到 accepted precision 和容量目标后逐步放量。

### Phase 4：可选扩展

- 完整结算图 `auto` 模式。
- 别名搜索与 OCR 共用 resolver。
- 独立识曲页。
- 批量相册 OCR worker；与单图同步 API 保持不同契约。
