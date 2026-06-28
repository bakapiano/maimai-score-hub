# 用户登录与注册流程

本文档根据当前代码实现整理。当前系统没有独立的“用户名/密码注册”入口；注册是登录流程中的隐式建档过程，用户身份主要由 `friendCode` 标识。已注册并已登录的用户可以在设置中创建自定义用户名和密码，后续使用 `friendCode` 或用户名 + 密码登录。

## 关键结论

- **没有公开密码注册入口**：首次建档仍依赖 maimai NET 好友关系验证或机台二维码反查。
- **用户表以 `friendCode` 唯一识别用户**：`UserEntity.friendCode` 是唯一索引；`username` 是用户后续可选设置的密码登录别名。
- **注册是隐式的**：
  - 好友码登录：提交登录请求时，如果 `friendCode` 不存在，后端立即创建 `User`。
  - 神秘二维码登录：首次二维码登录只有在成功反查出唯一 `friendCode` 后才创建或更新 `User`，并写入 `cabinetUserId`。
- **登录态是 JWT**：后端签发 30 天有效的 token，前端存入 `localStorage["netbot_token"]`。
- **受保护接口通过 `Authorization: Bearer <token>` 鉴权**，例如 `GET /api/v1/me`。
- **密码登录是可选增强**：只有已注册、已登录并设置过密码的用户可以使用，不会自动创建新用户。

## 相关入口

| 场景 | 前端入口 | 后端接口 |
| --- | --- | --- |
| 好友码登录 | `frontend/src/pages/LoginPage.tsx` | `POST /api/v1/auth/login-requests` |
| 查询好友码登录进度 | `LoginPage` 轮询 | `GET /api/v1/auth/login-requests/:jobId` |
| 手动唤醒好友码登录任务 | “我已接受请求” / “我已发送请求” | `POST /api/v1/auth/login-requests/:jobId/verify` |
| 神秘二维码登录 | `frontend/src/components/QrLoginForm.tsx` | `POST /api/v1/auth/qr-login` |
| 查询二维码慢路径进度 | `QrLoginForm` 轮询 | `GET /api/v1/auth/qr-login/:attemptId` |
| 设置/修改用户名与密码 | `frontend/src/components/SettingsPanel.tsx` | `PUT /api/v1/me/password` |
| 密码登录 | `frontend/src/pages/LoginPage.tsx` | `POST /api/v1/auth/password-login` |
| 校验当前登录态 | `AuthProvider` / `AuthedLayout` | `GET /api/v1/me` |

## 好友码登录 / 注册流程

### 1. 前端提交登录请求

用户在登录页选择“好友码登录”，输入 15 位数字好友码，并选择好友申请方式：

- `bot_sends_request`：Bot 向用户发送好友申请。
- `user_sends_request`：用户向 Bot 发送好友申请。

登录流程只完成身份验证，不再同时触发成绩更新；用户需要登录后在应用内手动更新成绩。

前端调用：

```http
POST /api/v1/auth/login-requests
{
  "friendCode": "...",
  "method": "bot_sends_request"
}
```

### 2. 后端创建或复用用户身份

`AuthService.requestLogin()` 会先 `trim()` 好友码，然后查找用户：

1. 如果 `users.findByFriendCode(friendCode)` 找到用户，继续使用该用户。
2. 如果找不到，立即 `users.create({ friendCode })`。

因此，好友码登录的“注册”发生在登录任务创建阶段，而不是最终验证成功后。即使后续好友验证失败，用户文档也可能已经存在。

如果环境变量 `SKIP_AUTH=true`，后端会跳过任务，直接签发 token；这是测试模式，不是正常生产流程。

### 3A. 方式一：Bot 向用户发送好友申请

后端创建 `send_friend_request` 类型 job，初始阶段是 `send_request`。Worker 处理流程：

1. 通过 maimai NET 好友搜索获取目标用户资料，写入 job 的 `profile`。
2. Bot 向用户 `friendCode` 发送好友申请，并验证申请已出现在已发送列表。
3. 成功后切换到 `wait_acceptance`，写入 `friendRequestSentAt`。
4. 前端展示“Bot 已发送好友申请”，要求用户核对申请时间后在 maimai NET 中接受。
5. 用户点击“我已接受请求”时，前端调用 verify 接口唤醒 job。
6. Worker 在 `wait_acceptance` 中检查双方是否已经成为好友：
   - 如果已经是好友，job 标记为 `completed`。
   - 如果还没接受，job 延迟 30 秒后再跑。
   - 超过 5 分钟仍未成为好友，则取消已发送申请并失败。

如果 Worker 发现用户反向发来了好友申请，也会尝试接受后再检查好友关系。

### 3B. 方式二：用户向 Bot 发送好友申请

后端先从可用 Bot 中选择一个 `available=true` 且好友数较少的 Bot，并创建 `accept_friend_request` 类型 job，初始阶段是 `wait_user_request`。返回体里会带 `botFriendCode`。

前端展示 Bot 好友码，用户在 maimai NET 中向该 Bot 发送好友申请，然后点击“我已发送请求”。Worker 处理流程：

1. 在 Bot 的待处理好友申请列表中查找来自该用户 `friendCode` 的申请。
2. 只接受创建登录请求时间之后发来的申请；旧申请会被视为过期并拉黑处理，避免误认历史请求。
3. 找到有效申请后切换到 `accept_request`，此时登录验证已经成立，轮询接口可以签发 token。
4. Bot 继续接受好友申请，成功后 job 标记为 `completed`。
5. 如果 5 分钟内没有等到有效申请，job 失败。

### 4. 前端轮询登录任务

创建 job 后，前端保存：

- `pendingLoginJobId`
- `pendingLoginBotFriendCode`
- `pendingLoginCreatedAt`

然后每秒轮询 `GET /api/v1/auth/login-requests/:jobId`。网络或 5xx 错误会做最多 5 次退避重试。

轮询返回 token 后，前端：

1. 调用 `setToken(token)`。
2. 清理 pending login 相关 localStorage。
3. 跳转到 `/app`。

### 5. 后端签发 token

`AuthService.checkStatus()` 在以下任一条件满足时签发 token：

- 登录 job 已经 `completed`。
- `accept_friend_request` 登录 job 已进入 `accept_request` 阶段。

签发 payload：

```json
{
  "sub": "<user Mongo _id>",
  "friendCode": "<friendCode>",
  "iat": 1234567890
}
```

有效期显式设置为 30 天。

如果登录 job 带有 `profile`，后端会同步写入用户 `profile`。登录流程不会创建 `update_score` job。

## 神秘二维码登录 / 注册流程

神秘二维码登录入口支持两种提交方式：

- 上传二维码图片，字段名为 `image`。
- 直接提交 JSON：`{ "qrCode": "SGWCMAID..." }`。

### 1. 后端扫描二维码

`AuthController.loginByQr()` 会从图片解码或读取 `qrCode` 字段，然后交给 `QrLoginService.loginByQr()`。

服务先调用 sdgb-worker：

```ts
sdgb.scanQr({ qrCode })
```

如果机台返回二维码过期，后端会返回稳定错误码 `qr_expired`，前端提示用户刷新二维码。

### 2A. 快路径：已绑定 `cabinetUserId`

如果扫描结果里的 `cabinetUserId` 已经能在用户表中找到：

1. 后端直接按该用户签发 token。
2. 返回 `{ kind: "fast", token, user }`。
3. 前端立即保存 token 并完成登录。

这也是首次成功二维码登录之后的后续登录路径。

### 2B. 慢路径：首次二维码登录

如果没有用户绑定该 `cabinetUserId`，后端进入异步慢路径：

1. 从二维码扫描结果中读取机台用户昵称 `rivalName`。
2. 根据扫描返回的成绩和本地 music 表计算 B50 rating。
3. 选择一个可用且已配置 `cabinetUserId` 的 Bot。
4. 创建 `qr_login_attempts` 记录，状态为 `pending`。
5. 立即返回 `{ kind: "async", attemptId }`。
6. 后台继续执行反查流程。

慢路径后台步骤：

1. 状态改为 `adding_rival`，通过 sdgb `addRival` 让 Bot 与该机台用户成为对手。
2. 状态改为 `waiting_snapshot`，主动创建一个 `get_full_friend_list` DXNet job，指定同一个 Bot 立即拉取完整好友列表；该 job 完成后会直接上报 Bot 状态和好友快照。
3. 最多等待 90 秒，直到 Bot 好友快照在本次 addRival 之后刷新。
4. 在快照中用 `(userName, rating)` 匹配唯一好友记录。
5. 如果没有匹配或匹配到多个候选，attempt 失败，并提示用户改用好友码登录。
6. 如果唯一匹配成功，得到真实 `friendCode`。
7. 根据 `friendCode` 查找或创建用户：
   - 不存在则创建 `User`，写入 `friendCode`、`cabinetUserId` 和占位 `profile`。
   - 已存在则补写 `cabinetUserId`；如果没有 profile，也写入占位 profile。
8. 签发 token，更新用户 `lastActiveAt`。
9. attempt 状态改为 `matched`，写入 token。

`qr_login_attempts` 有 1 天 TTL，只用于短期登录进度追踪。

运行中的二维码登录慢路径还会被 DXNet 好友清理保护：worker 通过
`GET /api/v1/workers/dxnet/qr-login/rival-names` 读取 `pending`、
`adding_rival`、`waiting_snapshot` 状态的 `rivalName` 列表。如果 Bot
好友列表里某个好友的 `userName` 命中该列表，即使此时还没有反查出
friendCode，cleanup 也会暂时保留它，避免在快照刷新前误删。

### 3. 前端轮询二维码 attempt

前端把 `attemptId` 存到 `localStorage["pendingQrLoginAttemptId"]`，以便刷新页面后继续轮询同一个 attempt。

轮询 `GET /api/v1/auth/qr-login/:attemptId`：

- `pending`：正在准备登录。
- `adding_rival`：正在添加好友。
- `waiting_snapshot`：确认好友身份中。
- `matched` 且返回 token：保存 token，完成登录。
- `failed`：展示后端错误并清除本地 attempt。

前端轮询间隔为 1 秒，最多等待 5 分钟；网络或 5xx 错误会退避重试。

## 用户名与密码设置流程

密码不是注册入口，只能由已经登录的用户在设置面板里创建或修改。

前端调用：

```http
PUT /api/v1/me/password
Authorization: Bearer <token>
{
  "username": "optional_name",
  "currentPassword": "old password",
  "newPassword": "new password"
}
```

字段规则：

- `username` 可选，作为密码登录别名；后端会规范化为小写，要求 3-32 位英文字母、数字或下划线，且不能是 15 位纯数字好友码。
- `newPassword` 可选；首次设置密码时必填，长度 8-72。
- 已有密码后，修改用户名或密码都必须提供正确的 `currentPassword`。

后端写入：

- `users.username`：唯一 sparse/partial index，历史用户可以为空，已设置用户名必须唯一。
- `users.passwordHash`：使用 Node `crypto.scrypt` 生成的版本化 hash，不保存明文。
- `users.passwordUpdatedAt`：最近一次更新密码的时间。

`GET /api/v1/me` 和 `PUT /api/v1/me/password` 的响应只返回 `username` 与 `hasPassword`，不会返回 `passwordHash`。

## 密码登录流程

密码登录入口接受 `friendCode` 或 `username` 二选一，再加 `password`：

```http
POST /api/v1/auth/password-login
{
  "friendCode": "15-digit-friend-code",
  "password": "..."
}
```

或：

```http
POST /api/v1/auth/password-login
{
  "username": "custom_username",
  "password": "..."
}
```

后端行为：

1. `friendCode` 与 `username` 必须且只能提供其中一个。
2. 提供 `friendCode` 时按 15 位好友码查找用户。
3. 提供 `username` 时按规范化后的用户名查找用户。
4. 用户不存在、未设置密码、密码错误都会返回统一失败信息，避免暴露账号枚举信息。
5. 验证成功后复用现有 JWT 签发逻辑，token payload 仍包含 `sub`、`friendCode`、`iat`，有效期 30 天。
6. 登录成功后更新用户 `lastActiveAt`。

前端拿到 token 后仍写入 `localStorage["netbot_token"]`，并把真实 `friendCode` 写入 `localStorage["lastFriendCode"]`；如果 profile 或登录响应里有用户名，也会写入 `localStorage["lastUsername"]` 用于下次回填。

## 登录态校验与退出

`AuthProvider` 启动时从 `localStorage["netbot_token"]` 读取 token。只要存在 token 且不是离线模式，就调用：

```http
GET /api/v1/me
Authorization: Bearer <token>
```

如果接口返回 401 或 403，前端清空 token。成功返回 profile 时，前端会把 `friendCode` 写入 `localStorage["lastFriendCode"]`，如果有 `username` 也会写入 `localStorage["lastUsername"]`，用于下次登录页预填。

后端 `AuthGuard` 的行为：

1. 要求 `Authorization` header 以 `Bearer ` 开头。
2. 调用 JWT verify。
3. 将 payload 放到 `req.user`。
4. 异步更新用户 `lastActiveAt`。

退出登录本质上是前端清除本地 token；后端目前没有服务端 session 或 token blacklist。

## 主要数据写入

| 数据 | 写入时机 |
| --- | --- |
| `users.friendCode` | 好友码登录请求创建时，或二维码慢路径反查成功时 |
| `users.username` | 已登录用户在设置面板保存自定义用户名时 |
| `users.passwordHash` | 已登录用户首次设置或修改密码时 |
| `users.passwordUpdatedAt` | 密码 hash 更新时 |
| `users.profile` | Worker 搜索到目标资料后写入 job，登录完成轮询时同步到用户；二维码慢路径会先写占位 profile |
| `users.cabinetUserId` | 二维码慢路径成功反查后写入；已绑定用户后续二维码登录走快路径 |
| `jobs` | 好友码登录和可选成绩更新都会创建 job |
| `qr_login_attempts` | 二维码首次登录慢路径创建，1 天后自动过期 |
| `localStorage.netbot_token` | 前端拿到 token 后写入 |
| `localStorage.lastFriendCode` | 好友码输入或 profile 校验成功后写入 |

## 当前实现注意点

- 好友码登录会在验证成功前创建用户文档，因此“已注册用户”不等于“曾成功登录”。
- 密码登录不会创建用户；必须先通过好友码或二维码流程注册并登录后设置密码。
- 自定义用户名只是密码登录别名，用户主身份和 token payload 仍以 `friendCode` / Mongo `_id` 为准。
- 创建新 job 时，后端会取消同一 `friendCode` 下尚未完成的旧 job，避免同一用户并发登录/更新互相干扰。
- 好友申请两种方式都有 5 分钟窗口；超时后 job 失败。
- 二维码慢路径依赖 sdgb-worker、可用 cabinet Bot、Bot 好友快照和 `(昵称, rating)` 唯一匹配；不满足时会失败。
- 如果 `AUTH_JWT_SECRET` 未配置，后端启动时会随机生成密钥；服务重启后旧 token 可能失效。
