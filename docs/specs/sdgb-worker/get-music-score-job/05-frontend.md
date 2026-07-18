# Frontend 交互

[← 返回总览](./README.md)

## 1. 更新方式选择

同步页提供两种手动更新方式：

- DX Net Bot；
- 二维码。

默认选择 DX Net Bot。浏览器可以在 localStorage 保存选择值 sync_update_method，但不得保存二维码字符串、图片内容或派生信息。

更新方式只影响本次手动同步，不修改 autoUpdate 设置。

## 2. 二维码输入

二维码模式提供：

- 文本框：粘贴当前有效的二维码字符串；
- 文件上传：PNG、JPEG 或 WebP 图片；
- 清空与重新选择；
- 提交前的类型、大小和必填校验。

提交后立即清空文本、文件引用和图片预览。失败重试也要求用户重新提供当前有效二维码。

不得把二维码写入：

- URL 或路由状态；
- localStorage、sessionStorage 或 IndexedDB；
- analytics、错误上报或录屏属性；
- 离线缓存和 Service Worker 缓存。

## 3. 可用性

- 未登录用户不能创建任务。
- 未绑定机台账号时禁用二维码方式，并引导用户先完成绑定。
- 同模式 active 时禁用对应重复提交；另一个模式仍可选择和提交。
- cleanup pending 或处于阻塞期的 unconfirmed 任务仍视为活动任务。
- 二维码图片解析在 backend 完成，Frontend 不需要读取或展示二维码内容。

## 4. 创建与轮询

提交成功后：

1. 保存 jobId 到当前页面状态。
2. 立即展示 queued 状态。
3. 轮询 /me/cabinet-score-jobs/:jobId。
4. 根据 stage 更新用户文案。
5. completed 后刷新最新 sync。
6. failed 且 cleanup 已结束后停止轮询。
7. cleanup pending 时继续轮询，即使业务 status 已为 failed。
8. unconfirmed 时展示 retryAfter，并保持新建任务禁用。

页面刷新时并行查询现有 DXNet 活动任务和 `/me/cabinet-score-jobs/active`；两个结果都可能
非空，必须分别恢复状态和轮询。

## 5. Stage 文案

| stage | 建议文案 |
| --- | --- |
| queued | 等待处理 |
| qr_auth | 正在校验二维码 |
| preview | 正在确认账号 |
| login | 正在准备成绩读取 |
| get_music | 正在读取成绩 |
| logout | 正在安全结束临时状态 |
| cleanup | 正在清理上一次状态 |
| persist | 正在保存成绩 |

progress.detailsFetched 存在时，可以显示“已读取 N 条成绩”。它是进度提示，不保证最终写入数量。

## 6. 成功与失败

成功时：

- 展示写入的 scoreCount；
- 刷新最新同步时间和成绩；
- 清除活动任务状态；
- 自动导出在后台独立进行；Frontend 读取 provider export state 的安全投影，不把二维码
  job 是否完成等同于外部平台是否已经追上 current version。

失败时：

- 只展示 backend 返回的安全文案；
- 不展示机台侧原始错误或 worker 调试信息；
- 不自动重用上次二维码；
- 如有 retryAfter，明确提示最早重试时间；
- cleanup 未完成时持续阻止新提交。

## 7. 分析与错误上报

允许记录：

- sync_started，method=cabinet_qr；
- sync_completed 或 sync_failed；
- 稳定错误码；
- 总耗时和用户可见阶段。

禁止记录：

- 二维码文本、图片、文件名或摘要；
- 绑定账号标识；
- 任务内部 payload；
- 原始成绩和 worker 私有错误。

## 8. 无障碍与移动端

- 方式选择、文本输入、文件选择和提交按钮应有清晰 label。
- 状态变化使用可被读屏识别的 live region。
- 移动端文件选择应允许从相册选图。
- 错误提示不能只依赖颜色。
