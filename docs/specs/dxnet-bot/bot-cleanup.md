# lastActiveAt 与 Bot 好友清理逻辑

本文只描述当前代码事实，字段定义见 `backend/src/modules/users/schemas/user.schema.ts`。

## 字段语义

`users.lastActiveAt` 是 `Date | null`，默认 `null`。它不是 Mongoose `timestamps` 自动维护的字段，只会被业务代码显式写入。

底层写入入口是 `UsersService.updateLastActiveAt(userId)`：

1. 只接受 MongoDB `_id` 字符串；`userId` 不是合法 ObjectId 时直接返回。
2. 对匹配用户执行 `updateOne({ _id: userId }, { lastActiveAt: new Date() })`。
3. 写入值是后端当前时间。

## 当前会更新 lastActiveAt 的路径

### 1. 密码登录成功

`AuthService.loginWithPassword()` 在密码校验成功后调用 `AuthService.updateLastActiveAt()`，再签发 JWT。

这个更新是 fire-and-forget：内部调用 `UsersService.updateLastActiveAt()`，并用 `.catch(() => {})` 忽略写入失败，不阻塞登录响应。

### 2. 访问受 AuthGuard 保护的接口

`AuthGuard` 在校验 `Authorization: Bearer <token>` 成功后：

1. 把 JWT payload 写入 `req.user`。
2. 如果 payload 里有 `sub`，调用 `AuthService.updateLastActiveAt(payload.sub)`。

因此，只要用户拿着有效 token 调用受 `AuthGuard` 保护的接口，就会刷新 `lastActiveAt`。当前 `backend/src/api/me/*` 下的 `me`、同步、DXNet job、导出相关接口使用了这个 guard。

这同样是 fire-and-forget，失败不会影响原接口响应。前端启动时通常会调用 `GET /api/v1/me` 校验 token，因此已有登录态的用户打开站点也会通过这个路径刷新活跃时间。

### 3. 二维码登录慢路径匹配成功

`QrLoginService.runSlowPath()` 在首次二维码登录的慢路径里，完成机台用户反查、找到或创建 `User`、签发 token 后，会调用 `UsersService.updateLastActiveAt(user._id)`。

代码注释里的目的很明确：慢路径会先通过 bot / sdgb 建立一段 bot 侧好友关系；立即把新用户标记为活跃，可以避免 DXNet worker 的好友清理任务在用户完成后续同步前把这段好友关系删掉。

这次写入是 await 的 best-effort：调用处会等待 Promise，但 `.catch(() => undefined)` 忽略写入失败。

## 当前不会立即更新 lastActiveAt 的路径

以下路径当前没有显式更新 `lastActiveAt`，但拿到 token 后的后续受保护接口请求通常会通过 `AuthGuard` 刷新：

1. 好友码登录 job 完成后，`AuthService.checkStatus()` 只在校验通过时签发 token；函数本身没有调用 `updateLastActiveAt()`。
2. `SKIP_AUTH=true` 的测试登录分支只直接签发 token；函数本身没有调用 `updateLastActiveAt()`。
3. 二维码登录快路径里，如果 `cabinetUserId` 已绑定已有用户，`QrLoginService.loginByQr()` 直接签发 token；函数本身没有调用 `updateLastActiveAt()`。
4. 自动更新调度、自动创建 `update_score` job、worker 完成自动更新 job 都不会直接更新 `lastActiveAt`。如果用户在前端开启或修改自动更新设置，请求本身会因为经过 `AuthGuard` 刷新一次 `lastActiveAt`；之后后台自动跑的更新不算用户活跃。

## Worker 如何读取活跃时间

DXNet worker 通过 Shared Secret 保护的 worker API 读取活跃度：

```http
POST /workers/dxnet/users/activity
{
  "friendCodes": ["..."]
}
```

后端实现为 `WorkerDxnetJobsController.getUsersActivity()`：

1. 入参必须有 `friendCodes` 数组。
2. 非字符串项会被过滤。
3. `UsersService.getActivityByFriendCodes()` 只查询存在的用户，并只返回 `friendCode`、`lastActiveAt` 和 `cabinetUserId`。
4. 响应里的 `lastActiveAt` 会转成 ISO 字符串；没有活跃时间则返回 `null`。`cabinetUserId` 有值表示该用户已经绑定机台 ID。
5. 后端查不到的 friendCode 不会出现在响应数组里。因此 activity 响应里是否存在某个 friendCode，也同时承担用户存在性判断：响应里有这条记录表示这是注册用户；没有记录表示后端查无此人。
6. worker 还会读取 `GET /workers/dxnet/qr-login/rival-names`。该接口从 `qr_login_attempts` 里返回正在运行的二维码登录慢路径玩家名（`pending`、`adding_rival`、`waiting_snapshot`），用于保护尚未解析出 friendCode 的 QR-login 好友。

## Bot 好友清理如何使用 lastActiveAt

好友清理任务在 `worker/src/common/bots/background-tasks/cleanup-friends.ts`，由 `startBotBackgroundTasks()` 启动，默认每 5 分钟运行一次，可通过 `CLEANUP_INTERVAL_MS` 覆盖。

一次清理只针对当前 worker 管理的 bot。任务在以下情况跳过：

1. 上一次清理还在运行。
2. 当前没有可用 bot。
3. bot 已过期。

对单个 bot，清理流程是：

1. 从 DXNet 拉取已发送好友请求、待接受好友请求、完整好友列表。
2. 调后端 `GET /workers/dxnet/bots/:botUserFriendCode/active-friend-codes` 获取该 bot 当前非终态 job 覆盖的 friendCode。后端筛选条件是同一个 `botUserFriendCode`，且 job `status` 不在 `completed`、`failed`、`canceled`。
3. 取消不在活跃 job 列表里的已发送好友请求。
4. 拒绝不在活跃 job 列表里的待接受好友请求。
5. 对完整好友列表调用 `/workers/dxnet/users/activity`，再调用 `/workers/dxnet/qr-login/rival-names` 获取 QR-login name 保护名单，最后筛选要删除的好友。

真正删除好友时，规则由 `selectInactiveFriends()` 决定：

| 条件（按优先级） | 结果 |
| --- | --- |
| friendCode 正在该 bot 的活跃 job 列表里 | 保留 |
| 好友 `userName` 命中正在运行的 QR-login `rivalName` | 保留；该流程可能还没解析出 friendCode |
| 已绑定 `cabinetUserId` | 删除；之后需要时可通过机台 `addRival` 加回来 |
| 有 `lastActiveAt`，且距当前时间超过 30 分钟 | 删除 |
| 有 `lastActiveAt`，且距当前时间不超过 30 分钟 | 保留 |
| activity 响应里有该 friendCode，但 `lastActiveAt` 为 `null` | 删除 |
| 上述清理后 bot 好友数仍超过 50，且好友有可排序的 `lastActiveAt` | 按 `lastActiveAt` 从旧到新继续删除，直到剩余好友数不超过 50，或没有更多可排序候选 |
| activity 响应里没有该 friendCode | 删除；不再保守保留 unknown friend |

删除动作调用 `client.friends.removeFriend(friendCode)`。单个好友删除失败只记录错误，不中断后续好友的清理。

## 设计含义

`lastActiveAt` 现在表示「最近一次成功登录或访问受保护后端接口的时间」，不是「最近一次完成同步」或「最近一次 DXNet 上有成绩变化」。

Bot 清理用它判断注册用户是否还处于近期站内活跃期：活跃 job 永远优先保留；正在 QR-login 慢路径中的 `rivalName` 也会按好友名保留。没有活跃 job 且不在 QR-login 保护名单里的好友，如果已绑定机台 ID、超过 30 分钟没有刷新 `lastActiveAt`、从未刷新过，或后端查无此人，就会从 bot 好友列表移除。已绑定机台 ID 的用户被优先移除，是因为后续需要时可以通过 sdgb `addRival` 恢复好友关系；unknown friend 不再保守保留，以免长期占用 bot 好友容量。
