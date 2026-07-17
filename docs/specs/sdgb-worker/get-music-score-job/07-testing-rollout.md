# 测试、发布与验收

[← 返回总览](./README.md)

状态：Implemented

测试只验证公开行为、安全边界和集成结果。机台侧协议测试、私有调用样例和 worker 源码级测试不写入本仓库文档。

## 1. Backend 测试

- JSON 文本和 multipart 图片可以创建同一类任务。
- 未提供输入、图片无法识别、类型不支持和文件过大返回稳定 4xx。
- 请求尝试指定 user、userId、friendCode 或未知字段时返回 400。
- 图片内容和上传元数据不会进入数据库或队列。
- 未登录、未绑定、owner 不匹配和已有活动同步均被拒绝。
- cleanup pending / unconfirmed 会阻止同 owner 创建新二维码任务。
- 用户只能查询自己的任务。
- 用户任务响应不包含二维码、绑定账号、临时凭据、原始成绩或 worker 元数据。
- 结果 owner 或绑定账号不一致时不写 sync。
- cleanup 未成功时不写 sync。
- 无有效成绩时不覆盖旧 sync。
- 重复完成请求只创建一个 sync 和一个自动导出任务。
- finalization 后只保留 syncId 和 scoreCount 摘要。

## 2. Frontend 测试

- 默认选择 DX Net Bot，现有流程无回归。
- 未绑定时二维码方式不可提交。
- 文本和图片均可创建任务。
- 提交后立即清空二维码和文件引用。
- 浏览器存储、URL、analytics 和错误上报中没有二维码数据。
- Stage 文案和读取数量正确更新。
- 页面刷新可以恢复活动任务。
- cleanup pending 时继续轮询并禁用新提交。
- unconfirmed 显示 retryAfter。
- completed 刷新 latest sync。
- failed 不自动复用旧二维码。
- 活动任务期间不能切换方式或重复创建。

## 3. Worker 黑盒验收

- 账号不匹配时，任务在成绩读取前失败。
- 成功任务生成完整成绩快照，并确认临时状态已安全结束。
- 任一业务错误都会进入安全收尾。
- 进程正常退出时停止领取新任务并优先完成收尾。
- 进程意外中断后，重启可以恢复清理。
- 多实例恢复同一任务时不会重复完成或互相覆盖。
- 清理无法确认时任务进入 unconfirmed，不写成绩。
- 中断后的旧任务即使清理成功，也要求新二维码重试。
- 日志、公开状态和可查询恢复元数据中没有敏感内容。

具体机台侧请求与实现断言由私有测试维护。

## 4. 端到端验收

使用专用测试账号和当前有效二维码：

1. 字符串和图片输入都能创建任务。
2. Frontend 能展示从 queued 到完成的脱敏阶段。
3. latest sync 正确更新 achievement、DX Score、FC/AP 和 FS/FDX。
4. 任务长期结果只包含 syncId 和 scoreCount。
5. 任务完成后账号可以正常继续使用，证明没有遗留临时状态。
6. 在测试环境中模拟 worker 中断，重启后能完成安全清理，旧任务不落成绩。
7. MongoDB、队列、Backend 日志、Worker 日志、Admin API 和浏览器存储中搜索不到二维码或临时凭据。
8. 自动导出失败不会回滚已写入的 sync。

## 5. 回归范围

- DX Net Bot 手动同步；
- 二维码绑定与登录；
- Rival-first 自动更新；
- 最新 sync 查询与成绩页；
- Diving-Fish / LXNS 自动导出；
- 多 backend 实例的幂等 finalization；
- sdgb job 队列修复与超时终态；
- Admin 任务列表和统计。

## 6. 发布顺序

1. 先部署向后兼容、支持 get_music_score 与安全收尾的 sdgb-worker。
2. 部署 shared 与 backend，验证用户 API 和 finalization。
3. 在受控测试环境完成正常流程和中断恢复 smoke test。
4. 发布 Frontend 二维码入口。
5. 观察成功率、等待时间、cleanup backlog、unconfirmed 和持久化失败。

发布资料不得把 worker 私有实现或运行时秘密复制到 commit、CI 日志或 issue。

## 7. 回滚

推荐顺序：

1. Frontend 停止新建二维码任务。
2. 等待活动任务与 cleanup 排空。
3. 回滚 backend 用户入口。
4. 最后回滚 worker。

已经进入敏感阶段的任务必须先完成安全收尾。紧急情况下也不能把未确认清理的任务直接标记为成功。

## 8. 验收标准

- 用户可以明确选择 DX Net Bot 或二维码。
- 二维码方式支持文本和 PNG/JPEG/WebP 图片。
- 只允许已登录、已绑定且没有活动手动同步的用户创建任务。
- 任务状态可以在页面刷新后恢复。
- 账号不匹配时不读取、不写入成绩。
- cleanup 未确认时不写 sync，并阻止新二维码任务。
- 成功结果正确更新 achievement、DX Score、FC/AP 和 FS/FDX。
- 用户、Admin、日志和长期任务记录不泄露敏感输入、临时凭据、绑定账号或原始成绩。
- 仓库文档不包含机台侧调用方法、服务地址、协议材料或 sdgb-worker 私有源码细节。
- 现有同步、绑定、自动更新和自动导出流程无回归。

## 9. 文档维护

后续内部实现变化只更新私有运维资料。本目录只在以下公开行为变化时更新：

- 用户 API 或公开任务字段变化；
- Frontend 交互变化；
- 成绩映射或持久化规则变化；
- cleanup 的用户可见语义变化；
- 安全与验收边界变化。
