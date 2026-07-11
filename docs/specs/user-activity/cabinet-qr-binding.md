# 机台二维码绑定校验

本文档描述已登录用户通过 `PUT /api/v1/me/cabinet` 绑定机台 `cabinetUserId` 时的身份校验规则。目标是在有足够同步成绩时优先使用强确定性的成绩校验，同时允许只有少量或没有成绩的用户使用二维码登录同款反查流程完成绑定。

## 结论

- 用户有至少 10 条本地成绩时，二维码扫描结果必须精确匹配至少 10 条成绩。
- 用户有 4 至 9 条本地成绩时，有多少条就必须精确匹配多少条。
- 用户只有 0 至 3 条本地成绩时，使用二维码登录慢路径共用的 `昵称 + B50 Rating` 反查逻辑。
- 反查得到的 `friendCode` 必须等于当前登录用户的 `friendCode`，否则拒绝绑定。
- 4 条以上成绩进入成绩分支后，匹配失败不会再回退到昵称 + Rating 分支。

## 分支表

| 最新同步中的成绩数 | 校验方式               | 成功条件                               |
| -----------------: | ---------------------- | -------------------------------------- |
|                0-3 | 二维码登录同款身份反查 | 唯一反查出的 `friendCode` 等于当前用户 |
|                4-9 | 成绩匹配               | 所有本地成绩均精确匹配                 |
|                10+ | 成绩匹配               | 至少 10 条精确匹配                     |

## 成绩精确匹配

后端读取用户最新一份 sync，并把本地成绩与二维码扫描返回的 `GetUserRivalMusicApi` 成绩按以下字段关联：

1. `musicId`
2. `chartIndex` / cabinet `level`

关联后必须同时满足：

- 本地 `score` 转换后的 achievement 与 cabinet `achievement` 相同。
- 本地 `dxScore` 与 cabinet `deluxscoreMax` 相同。

同一行只有两个数值都相同才计为一条匹配。达到当前分支阈值后可以提前结束比较。

## 少量成绩身份反查

少于 4 条成绩的绑定与二维码登录慢路径共用 `CabinetIdentityMatcherService`，流程为：

1. 用扫描结果中的成绩和本地曲库计算 B50 Rating。
2. 选择可用且已配置 `cabinetUserId` 的 Bot。
3. 通过 sdgb `addRival` 添加二维码对应的机台用户。
4. 创建 `get_full_friend_list` job，刷新同一个 Bot 的完整好友列表快照。
5. 在新快照中按 `(userName, rating)` 查找唯一好友。
6. 将得到的 `friendCode` 与当前登录账号比较，一致才允许绑定。

昵称或 Rating 无法唯一匹配、Bot 不可用、曲库不足以计算 Rating、快照刷新超时，都会终止绑定，不会写入 `cabinetUserId`。

## 接口结果

成功返回 HTTP 201：

```json
{ "ok": true }
```

身份不匹配返回 HTTP 409。成绩分支会返回 `verification: "scores"`、`matchedRows` 和 `requiredRows`；少量成绩反查出的好友码不一致时返回 `verification: "profile"`。
