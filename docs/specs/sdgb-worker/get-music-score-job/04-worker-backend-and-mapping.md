# Backend 持久化与成绩映射

[← 返回总览](./README.md)

本文描述 sdgb-worker 黑盒输出进入 backend 后的业务规则。worker 内部实现和机台侧原始数据结构不在本文范围内。

## 1. Finalization 前置条件

backend 只有在以下条件全部满足时才写入成绩：

- 任务类型为 get_music_score；
- worker 上报有效的 completed 结果；
- 执行身份与当前任务匹配；
- 任务 owner 完整；
- 当前用户的绑定账号仍与任务预期一致；
- 结果对应同一绑定账号；
- cleanupStatus 为 succeeded；
- 成绩快照通过 schema 与业务校验。

任一条件失败都不得修改现有 sync。

## 2. Finalization 流程

1. 校验 worker 完成请求的身份和幂等信息。
2. 校验任务 owner、绑定账号和清理状态。
3. 将内部成绩快照转换为统一 sync score。
4. 过滤无效或无法映射的记录。
5. 与当前用户成绩按现有规则合并。
6. 写入最新 sync。
7. 把任务结果压缩为 syncId 和 scoreCount，并清除敏感输入及原始结果。
8. 如用户已配置查分器导出，异步创建 cabinet_qr_update 导出任务。

导出失败不回滚已经成功写入的 sync。

## 3. 统一成绩语义

内部成绩快照必须提供足够信息以生成：

| Sync 字段 | 业务语义 |
| --- | --- |
| musicId | 本地曲目与谱面标识 |
| difficulty | 标准难度 |
| score | achievement 百分比 |
| dxScore | DX Score |
| fc | FC、FC+、AP、AP+ 或 null |
| fs | FS、FS+、FDX、FDX+ 或 null |
| playCount | 可选游玩次数 |

机台侧字段名、数值枚举和转换实现属于私有 worker/shared contract，不在公开文档中展开。

## 4. 映射规则

- 曲目和谱面必须能映射到本地 catalog。
- 不支持的特殊谱面不写入普通成绩列表。
- 未游玩的零值占位不作为有效成绩。
- 未知曲目跳过并记录计数，不能使整个任务崩溃。
- 同一谱面出现重复记录时使用确定性规则合并。
- achievement 与 DX Score 保留更高值。
- FC 与 FS 使用现有等级顺序保留更高状态。
- 映射后没有任何有效成绩时返回 NO_SCORE_DATA，不覆盖旧 sync。

## 5. 幂等与并发

- 同一任务的 completed 请求重复到达时，只允许创建一个 sync。
- 自动导出以 source job 去重。
- finalization 必须使用条件更新，避免两个 backend 实例同时完成同一任务。
- 如果用户绑定在任务执行期间发生变化，finalization 必须失败。
- 任务终态写入失败时不得留下包含二维码或原始成绩的半成品结果。

## 6. 持久化最小化

sdgb_jobs 长期保留：

- 任务 ID、owner 引用和 job type；
- status、stage、cleanupStatus；
- 脱敏错误码；
- syncId、scoreCount；
- 必要时间戳和执行审计信息。

sdgb_jobs 不长期保留：

- 二维码或图片信息；
- 临时会话凭据；
- 机台侧请求与响应；
- 原始成绩快照；
- worker 私有恢复信息。

## 7. 失败规则

| 场景 | 行为 |
| --- | --- |
| Owner 或绑定校验失败 | 任务失败，不写 sync |
| Cleanup 未成功 | 拒绝 finalization，继续或等待清理 |
| 无有效成绩 | NO_SCORE_DATA，旧 sync 不变 |
| Sync 写入失败 | SYNC_PERSIST_FAILED，旧 sync 不变 |
| 自动导出失败 | 保留成功 sync，单独记录导出失败 |
| 重复 completed | 返回已有终态，不重复写入 |
