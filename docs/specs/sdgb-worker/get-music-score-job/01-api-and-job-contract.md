# API 与公开 Job Contract

[← 返回总览](./README.md)

本文只描述浏览器可以使用的用户 API 和脱敏任务视图，不描述 worker 内部接口、任务载荷或机台侧调用。

## 1. 更新方式

| 值 | UI 文案 | 用户入口 |
| --- | --- | --- |
| dxnet_bot | DX Net Bot | 现有 DXNet 同步流程 |
| cabinet_qr | 二维码 | /me/cabinet-score-jobs |

默认方式为 dxnet_bot。浏览器可以保存用户选择的方式，但不得保存二维码字符串或图片。

## 2. 创建二维码成绩任务

接口：

    POST /api/v1/me/cabinet-score-jobs
    Authorization: Bearer <jwt>

JSON 输入：

    { "qrCode": "<current-qr-value>" }

也支持 multipart/form-data：

    image=<png-jpeg-or-webp-file>

multipart 可以提供 qrCode 文本。文本和图片同时存在时，使用非空文本。

### 2.1 输入规则

- qrCode 必须是非空字符串，长度上限为 512。
- 图片支持 PNG、JPEG 和 WebP，文件大小上限为 5 MiB。
- 图片无法识别二维码时返回 QR_IMAGE_DECODE_FAILED。
- 文本和图片都不存在时返回 QR_INPUT_REQUIRED。
- JSON 和 multipart 普通字段使用严格校验。
- 请求不得包含 user、userId、friendCode 或其他用于覆盖登录身份的字段。
- 图片只用于当前请求内解码，不能进入数据库、队列或 worker。

### 2.2 身份与互斥

backend 必须：

1. 只从 JWT 取得当前用户。
2. 确认用户已完成机台账号绑定。
3. 确认没有另一个 active `get_music_score`。
4. 确认没有尚未安全结束的二维码 session cleanup；DXNet 活动任务不阻止创建。
5. 由 backend 写入任务 owner 和预期绑定账号。
6. 创建内部 get_music_score 任务并返回 HTTP 202。

如果创建条件不满足，返回稳定的 4xx 错误，不创建任务。

### 2.3 创建响应

响应结构：

    {
      "jobId": "uuid",
      "job": {
        "id": "uuid",
        "method": "cabinet_qr",
        "status": "queued",
        "stage": "queued",
        "cleanupStatus": "not_required",
        "progress": null,
        "syncId": null,
        "scoreCount": null,
        "error": null,
        "createdAt": "ISO-8601",
        "updatedAt": "ISO-8601"
      }
    }

## 3. 查询任务

查询自己的指定任务：

    GET /api/v1/me/cabinet-score-jobs/:jobId
    Authorization: Bearer <jwt>

查询自己的活动任务：

    GET /api/v1/me/cabinet-score-jobs/active
    Authorization: Bearer <jwt>

指定任务只允许 owner 查询。不存在或不属于当前用户时统一返回 404，避免枚举其他用户的任务。

活动任务响应为：

    { "job": CabinetScoreJob | null }

活动任务包括：

- queued 或 processing；
- 业务已经失败但 cleanupStatus 为 pending；
- cleanupStatus 为 unconfirmed 且仍处于安全阻塞期。

Frontend 在刷新页面后使用活动任务接口恢复轮询。

## 4. 公开任务字段

| 字段 | 含义 |
| --- | --- |
| id | 任务 ID |
| method | 固定为 cabinet_qr |
| status | queued、processing、completed 或 failed |
| stage | 当前用户可见阶段 |
| cleanupStatus | 临时登录状态是否已安全结束 |
| progress | 可选的成绩读取数量 |
| syncId | 成功写入的 sync ID，否则为 null |
| scoreCount | 成功写入的成绩数量，否则为 null |
| error | 脱敏后的错误码、文案和可选 retryAfter |
| createdAt / updatedAt | ISO-8601 时间 |

### 4.1 Stage

Stage 是稳定的用户状态，不等同于 worker 的内部调用步骤。

| stage | 用户含义 |
| --- | --- |
| queued | 等待处理 |
| qr_auth | 校验二维码 |
| preview | 确认账号信息 |
| login | 准备安全读取 |
| get_music | 读取成绩 |
| logout | 结束临时登录状态 |
| cleanup | 清理或恢复临时状态 |
| persist | 保存成绩 |

### 4.2 Cleanup 状态

| cleanupStatus | 含义 |
| --- | --- |
| not_required | 尚未产生需要清理的状态 |
| pending | 正在清理，任务仍需轮询 |
| succeeded | 已确认安全结束 |
| unconfirmed | 暂时无法确认，按 retryAfter 阻止新任务 |

业务 status 为 failed 不代表 cleanup 已结束。Frontend 必须同时检查 cleanupStatus。

## 5. 公开响应脱敏

用户响应不得包含：

- 内部任务 payload 或 worker 执行元数据；
- 二维码原文、摘要或图片信息；
- 绑定账号标识；
- 临时会话凭据或恢复记录；
- 原始成绩快照；
- 机台侧地址、请求、响应或错误正文；
- sdgb-worker 私有实现信息。

Admin 的列表与详情也必须使用专门的脱敏视图，不能直接序列化数据库实体。

## 6. 内部任务边界

get_music_score 是 backend 与 sdgb-worker 之间的内部任务类型。仓库内共享定义可以包含完成路由所需的最小字段，但公开文档不记录 worker 的私有请求格式、机台侧字段或实现步骤。

内部结果到达 backend 后必须经过 schema 校验、owner 校验、绑定账号校验和幂等终态处理，不能直接透传给用户。
