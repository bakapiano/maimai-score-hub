# Passkey / WebAuthn 登录与管理

本文档定义 maimai Score Hub 的 Passkey（WebAuthn）登录、凭据管理、数据模型与安全边界。Passkey 是现有好友码、账号密码和二维码登录之外的第四种登录方式，不替代现有账号注册与恢复链路。

## 产品约束

- 用户仍需先通过现有登录方式建立并进入账号。
- 创建 Passkey 前必须已经设置账号密码，并再次输入正确的当前密码。
- 删除 Passkey 时必须再次输入正确的当前密码。
- Passkey 日常登录不再要求密码。
- 单个用户最多保存 10 个 Passkey。
- 支持系统 Passkey、同步型 Passkey、跨设备认证和实体安全密钥。
- 管理界面支持创建、列表、重命名、查看创建/最近使用时间和删除。
- 旧入口 `maimai.bakapiano.com` 使用 308 跳转到规范入口 `maiscorehub.bakapiano.com`，不直接执行 WebAuthn ceremony。

## WebAuthn 配置

生产环境固定配置：

```env
WEBAUTHN_RP_NAME=maimai Score Hub
WEBAUTHN_RP_ID=maiscorehub.bakapiano.com
WEBAUTHN_ORIGINS=https://maiscorehub.bakapiano.com
```

本地开发使用：

```env
WEBAUTHN_RP_NAME=maimai Score Hub (Local)
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGINS=http://localhost:3001
```

`RP_ID` 是前端页面域名，不是 `api.maiscorehub.bakapiano.com`。所有生产 ceremony 必须在 HTTPS 安全上下文中执行；本地开发使用浏览器允许的 `localhost` 例外，不使用 `127.0.0.1` 作为 RP ID。

后端验证必须同时满足：

- challenge 与 Redis 中保存的值完全一致；
- `expectedRPID` 等于环境配置的 RP ID；
- `expectedOrigin` 是配置中明确列出的完整 Origin；
- user presence 和 user verification 均为真；
- assertion 签名、公钥和 signature counter 验证成功。

## 数据模型

新增 MongoDB 集合 `passkey_credentials`。一个用户对应零到多条凭据记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 管理接口使用的记录 ID |
| `userId` | ObjectId | 关联 `users._id`，普通索引，不唯一 |
| `credentialId` | string | WebAuthn credential ID 的 Base64URL 表示，全局唯一 |
| `publicKey` | Buffer | COSE 公钥，不在管理响应中返回 |
| `counter` | number | 最近一次认证后的 signature counter |
| `transports` | string[] | authenticator transport 提示 |
| `deviceType` | string | `singleDevice` 或 `multiDevice` |
| `backedUp` | boolean | 凭据是否已备份/同步 |
| `name` | string | 用户可编辑名称，trim 后 1–50 字符 |
| `lastUsedAt` | Date/null | 最近一次成功登录时间 |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps |

索引：

```text
unique(credentialId)
index(userId, createdAt desc)
```

WebAuthn user handle 使用 `users._id` 十六进制解码后的 12 个字节，保持稳定、不可修改且不包含好友码或用户名。登录时以 `credentialId` 查找凭据和用户，并在响应包含 user handle 时进行一致性校验。

账号删除必须同步删除该用户的全部 `passkey_credentials`，删除响应的 `deleted` 对象增加 `passkeys` 计数。服务端永远不接收或保存私钥。

## Challenge 与 ceremony

注册和认证均使用后端生成的随机 challenge。每次 options 响应同时返回不可猜测的 `ceremonyId`，Redis 保存：

```ts
type PasskeyCeremony = {
  type: "registration" | "authentication";
  challenge: string;
  userId?: string;
  passwordUpdatedAt?: string | null;
};
```

Redis key 为 `webauthn:ceremony:<ceremonyId>`，TTL 为 300 秒。verify 开始时必须使用原子 GET-and-delete 消费记录，因此每个 challenge 只能尝试一次；超时、失败或用户取消后均需重新获取 options。

注册 ceremony 绑定 JWT 中的 `sub`，并记录 options 创建时的 `passwordUpdatedAt`。verify 时 JWT 用户和密码版本必须仍然一致，避免 ceremony 被转交给其他账号或在密码变更后继续使用。认证 ceremony 不预先绑定用户，由 assertion 的 credential ID 反查用户。

## API

所有路径均位于 `/api/v1`。

### Passkey 登录

#### `POST /auth/passkey/options`

无请求体。返回：

```ts
{
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}
```

认证 options 使用：

- 配置的 RP ID；
- `userVerification: "required"`；
- 不提供 `allowCredentials`，由 discoverable credential 账号选择器选择用户。

#### `POST /auth/passkey/verify`

请求：

```ts
{
  ceremonyId: string;
  response: AuthenticationResponseJSON;
}
```

成功后更新 `counter`、`backedUp` 和 `lastUsedAt`，更新用户 `lastActiveAt`，并返回与密码登录一致的 `{ token, user }`。未知 credential、错误签名、错误 user handle 和 counter 异常统一返回：

```json
{ "code": "invalid_passkey", "message": "Passkey 登录失败" }
```

HTTP 状态为 401，不暴露账号或 credential 是否存在。

### Passkey 管理

以下接口全部要求 `Authorization: Bearer <token>`。

#### `GET /me/passkeys`

返回当前用户的安全摘要数组：

```ts
type PasskeySummary = {
  id: string;
  name: string;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};
```

#### `POST /me/passkeys/registration/options`

请求 `{ password: string }`。后端要求用户已有 `passwordHash`，验证当前密码，检查凭据数量小于 10，然后生成：

- `residentKey: "required"`；
- `userVerification: "required"`；
- `attestationType: "none"`；
- 不设置 `authenticatorAttachment`；
- `excludeCredentials` 包含当前用户全部已有 credential。

返回 `{ ceremonyId, options }`。

#### `POST /me/passkeys/registration/verify`

请求：

```ts
{
  ceremonyId: string;
  name: string;
  response: RegistrationResponseJSON;
}
```

校验 JWT 用户、challenge、密码版本、Origin、RP ID 和 user verification，保存新 credential，HTTP 201 返回 `PasskeySummary`。唯一索引冲突返回 `passkey_already_registered`。

#### `PATCH /me/passkeys/:id`

请求 `{ name: string }`，仅允许修改当前用户凭据名称，不需要再次输入密码。不存在或不属于当前用户时统一返回 404。

#### `POST /me/passkeys/:id/delete`

请求 `{ password: string }`。验证记录归属和当前密码后删除；错误密码不删除，成功返回 `{ ok: true }`。

### 稳定错误

| code | HTTP | 场景 |
| --- | ---: | --- |
| `password_required` | 409 | 当前账号尚未设置密码 |
| `invalid_password` | 403 | Passkey 创建/删除时密码错误 |
| `passkey_limit_reached` | 409 | 当前用户已有 10 个 Passkey |
| `passkey_already_registered` | 409 | credential ID 唯一索引冲突 |
| `challenge_expired` | 400 | ceremony 不存在、已使用或过期 |
| `invalid_passkey` | 401 | Passkey 登录验证失败 |

密码失败按 user ID 固定窗口限制为 10 分钟最多 5 次；公开登录 options/verify 按可信反向代理得到的客户端 IP 限制为每分钟 30 次。超过限制返回 429。

## JWT 签发

Passkey 验证成功后沿用当前 JWT payload 和 30 天有效期：

```json
{
  "sub": "<user Mongo _id>",
  "friendCode": "<friendCode>",
  "iat": 1234567890
}
```

好友码、密码、二维码和 Passkey 登录必须共用同一个 token 签发方法，避免安全字段和有效期出现分叉。前端继续把 token 写入现有 `localStorage["netbot_token"]`；迁移 HttpOnly Cookie 不属于本功能范围。

## 前端登录

登录页在现有三个页签后增加“网站密钥”页签：

1. 检查 `window.PublicKeyCredential`；不支持时显示兼容性说明。
2. 用户点击“使用网站密钥登录”。
3. 获取 authentication options，调用 `startAuthentication()`。
4. 提交 verify 响应。
5. 成功后通过现有 AuthProvider 保存 token，记录 `login_success` 且 method 为 `passkey`，跳转 `/app`。

用户主动取消系统选择器或认证超时时保持在当前页面，不显示服务端故障提示；验证失败、challenge 过期和网络错误使用可重试提示。Passkey 操作期间禁用其他登录提交，避免并发状态冲突。

## 前端管理

账号设置面板新增“网站密钥”区域：

- 打开设置时加载摘要列表。
- `hasPassword=false` 时禁用创建，并提示先在上方设置密码。
- 创建弹窗收集名称和当前密码，先获取 registration options，再调用 `startRegistration()` 并 verify。
- 密码只保存在组件内存，流程结束、取消或失败后立即清空，不写入 localStorage、日志或 analytics。
- 列表显示名称、创建时间、最近使用时间以及“同步型/单设备”状态。
- 重命名使用内联或小型弹窗编辑，成功后刷新本地列表。
- 删除先确认，再要求输入当前密码；成功后移除列表项。
- 达到 10 个时禁用创建并显示数量上限。

## 域名与部署

- 规范前端 Origin：`https://maiscorehub.bakapiano.com`。
- API 允许的 CORS Origin 必须显式包含规范前端 Origin，不能为 WebAuthn 放开通配符。
- 旧域名 `https://maimai.bakapiano.com/<path>?<query>` 返回 308，Location 保留原 path/query 并指向规范域名。
- 部署顺序：后端与 Mongo 唯一索引 → 前端 → 旧域名跳转。
- 日志和观测只记录 ceremony 类型、结果和稳定错误码，不记录密码、challenge、credentialId、公钥或 WebAuthn 原始响应。

## 验收标准

- 已设置密码的用户能创建两个不同 Passkey，列表、重命名和时间字段正确。
- 未设置密码、密码错误、达到 10 个和重复 credential 均得到稳定错误。
- challenge 过期或重放、Origin/RP ID 错误、缺少 UV、签名/counter 错误均无法注册或登录。
- 用户退出后可在没有用户名和密码输入的情况下选择 Passkey 登录。
- 两个 Passkey 都能独立登录；删除其中一个不影响另一个，已删除凭据不能再登录。
- 用户不能查看、修改或删除其他用户的 Passkey。
- 删除账号后不存在残留 Passkey credential。
- 原有好友码、账号密码和二维码登录保持可用。
- 本地 `localhost` dev 环境完成后端 E2E，覆盖注册、登录、管理、重放和账号删除链路。
- 旧域名请求被重定向到规范域名，并保留 path/query。

## Dev E2E

启动配置为 `RP_ID=localhost`、前端 Origin 为 `http://localhost:3001` 的后端与前端后运行：

```powershell
npm --prefix backend run test:e2e:passkey
```

脚本使用本机 Chrome/Edge 的 Chromium virtual authenticator，要求后端启用 `SKIP_AUTH=true` 并连接隔离的测试数据库。可通过 `PASSKEY_E2E_BASE_URL` 和 `PASSKEY_E2E_BROWSER` 覆盖默认前端地址与浏览器路径。脚本验证密码前置、注册、列表、重命名、前端登录、API 登录、最近使用时间、challenge 重放、错误/正确密码删除、未知 credential 和账号删除级联。
