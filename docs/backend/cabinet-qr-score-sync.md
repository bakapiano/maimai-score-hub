# 二维码成绩更新代码事实

本文记录当前已实现的用户侧二维码成绩更新，不描述早期方案。相关入口：

- 用户 API：`backend/src/api/me/me-cabinet-score-jobs.controller.ts`
- 业务协调/finalizer：`backend/src/modules/cabinet-score-sync/`
- SDGB job：`backend/src/modules/sdgb-worker/`
- 成绩映射：`SyncService.createFromUserMusic()`
- 独立 worker：`sdgb-worker/src/get-music-score.ts`、`session-lease.ts`、`sdgb/api.ts`
- Shared contract：`shared/src/modules/sdgb-worker/`、`shared/src/modules/sync/`

## 与 DXNet 更新的边界

二维码更新不是 DXNet `jobs` 中的新类型。

| 更新方式 | Mongo | jobType | BullMQ | 执行者 |
| --- | --- | --- | --- | --- |
| DXNet | `jobs` | `update_score`，必要时先 `send_friend_request` | 每 bot 一个 `dxnet-worker-jobs-<friendCode>` | DXNet worker |
| 二维码 | `sdgb_jobs` | `get_music_score` | `sdgb-worker-interactive-jobs` | Interactive sdgb-worker |

两种手动更新在创建时共用 `lock:manual-score-create:{friendCode}`，并交叉检查 active job，防止同一用户同时写最新 sync。

## 用户接口

前端只调用本节的 `/me/cabinet-score-jobs/*` 用户接口。`/workers/sdgb/jobs/*` 只允许持有 shared secret 的 sdgb-worker 获取/回写内部 job，不能由浏览器或用户客户端调用。

### 创建

```http
POST /api/v1/me/cabinet-score-jobs
Authorization: Bearer <jwt>
```

支持：

```json
{ "qrCode": "..." }
```

或 multipart `image`。图片在 backend 用 `decodeQrImage()` 解码，worker 只接收字符串。JSON/multipart 普通字段使用 strict schema，不接受 `user`、`userId`、`friendCode`；owner 和绑定 ID 来自 JWT + 数据库。

前置条件：

- 当前用户存在；
- 已绑定 `cabinetUserId`；
- 没有 active DXNet 手动同步；
- 没有 active/pending/unconfirmed-blocked 的 `get_music_score`。

成功返回 HTTP 202。二维码保存在活动 job payload 中供 worker 读取；所有失败/完成终态都会清除 `payload.qrCode`。

### 查询

```text
GET /api/v1/me/cabinet-score-jobs/active
GET /api/v1/me/cabinet-score-jobs/:jobId
```

只按 JWT `sub` 返回当前 owner 的脱敏 view。响应不包含 payload、cabinet userId、cookie/token、lease、原始 `musicDetails`。`active` 除 queued/processing 外还包含 cleanup pending，以及仍在 `cleanupBlockedUntil` 内的 unconfirmed job。

## Worker 完整流程

```text
queued
  -> qr_auth
  -> preview
  -> login
  -> get_music
  -> logout / cleanup
  -> persist
  -> completed
```

### 1. QR auth 与身份校验

- wc_aime 返回 `userID`、Aime token 和可选 accessCode/authKey。
- `userID` 必须等于 backend 写入的 `expectedCabinetUserId`；不一致时在 Login 前失败。
- QR、token、cookie 不写日志。`SDGB_DEBUG=1` 也只输出是否存在 token。

### 2. Preview 在 Login 前

`GetUserPreviewApi` 在 Login 前调用：

- `errorId != 0`：失败；
- `isLogin=true`：以 `ACCOUNT_ALREADY_LOGGED_IN` 失败，绝不再次 Login；
- Preview 不创建 session。

### 3. Durable login intent

生成本次 `loginDateTime` 后，顺序固定为：

```text
PATCH backend stage=login
  -> Redis 写 AES-GCM login_intent
  -> UserLoginApi
```

backend/Redis/加密写入失败时不发送 Login。Login 请求使用：

- `dateTime`：worker 生命周期内稳定的 machine auth time；
- `loginDateTime`：本次请求生成的 unix 秒；
- QR Aime token；
- `isContinue=false`、`genericFlag=0`。

收到 Login HTTP 响应头的 `Set-Cookie` 后，worker 先把 cookie 加密写成 `session_open` 并等待 Redis ACK，再读取/解密响应 body。`returnCode=1` 且存在 cookie 才继续。

### 4. GetUserMusic

`GetUserMusicApi` 是本人主成绩接口，需要 Login 后的 JSESSIONID；无 token/cookie 探测返回空串。它和无需用户登录的 `GetUserRivalMusicApi` 不同。

当前只发一次：

```json
{
  "userId": 12345678,
  "nextIndex": 0,
  "maxCount": 999999
}
```

响应必须 `nextIndex=0`，否则以 `INCOMPLETE_MUSIC_RESPONSE` 失败。worker 扁平化 `userMusicList[].userMusicDetailList`，最多接受 10,000 条详情。

### 5. Logout 的 60 秒硬约束

Login 成功后至少等待 60 秒才发送 Logout。所有尝试复用以下原值：

- Login 响应 cookie；
- Login 请求的同一个 `loginDateTime`；
- userId、accessCode、region/place/client；
- `type=1`。

实测同一 session 在 5/10/15/20/30/45 秒调用 Logout 都返回 `returnCode=1`，但随后 Preview 仍为 `isLogin=true`；60.9 秒时才变为 false。因此不能只信 Logout returnCode。

当前成功条件是：

```text
UserLogoutApi returnCode=1
  AND
随后 GetUserPreviewApi isLogin=false
```

Preview 仍为 true 时，worker 保留 cookie/token/lease，用完全相同的 `loginDateTime` 重试；最多立即尝试三轮，再进入定时 recovery。只有确认 false 才允许删除 lease 和进入 persist。

## Cleanup lease

默认 Redis key（`REDIS_KEY_PREFIX=maimai:` 时）：

```text
maimai:sdgb:session-lease:{jobId}
maimai:sdgb:session-lease:cleanup-lock:{jobId}
```

敏感明文位于 AES-256-GCM ciphertext：userId、loginDateTime、login 成功时间、cleanup 开始时间、cookie、短时效 Aime token、accessCode。envelope 的 phase/heartbeat/fence metadata 不含用户 ID。

状态：

```text
login_intent
  -> session_open
  -> logout_pending
  -> recovering（崩溃接管）
  -> closed
  -> 删除
```

触发 cleanup/recovery 的入口：

- 正常或异常 `finally`；
- SIGINT/SIGTERM graceful shutdown；
- worker 启动扫描；
- 默认每 15 秒扫描 stale lease；
- BullMQ stalled job 重投前；
- 新二维码登录前的旧 session 检查。

活跃 lease 默认每 10 秒 heartbeat，45 秒 stale 后才允许 recovery。接管使用 Redis cleanup lock + fence token，防止旧 worker 恢复后继续 persist。

首次 Logout/Preview 验证失败时 job 为 `cleanupStatus=pending`，不写 sync；超过 10 分钟仍无法确认时变为 `unconfirmed` 并设置 `cleanupBlockedUntil`。Recovery 成功后旧业务 job 仍以 `WORKER_INTERRUPTED_SESSION_CLEANED` 失败，要求新二维码重试，不能从 lease 恢复成绩结果。

## Backend finalization 与成绩映射

Worker 在 Logout + Preview 确认后 PATCH completed，并临时提交：

```ts
{
  cabinetUserId: number;
  musicDetails: UserMusicDetail[];
}
```

`CabinetScoreSyncService.finalize()` 同步检查：

1. result Zod schema 和 10,000 条上限；
2. job owner 存在；
3. `result.cabinetUserId === expectedCabinetUserId === user.cabinetUserId`；
4. `cleanupStatus === "succeeded"`；
5. `SyncService.createFromUserMusic()` 返回有效 sync。

映射规则：

| Cabinet | Sync |
| --- | --- |
| `achievement` | `(achievement / 10000).toFixed(4) + "%"` |
| `deluxscoreMax` | `dxScore` 字符串 |
| `comboStatus 1/2/3/4` | `fc/fcp/ap/app` |
| `syncStatus 1/2/3/4` | `fs/fsp/fdx/fdxp` |
| `syncStatus=5 (SyncPlay)` | `null`，不是 Full Sync |

achievement 和 DX 均为 0 的占位记录会过滤；未知曲目/谱面跳过；新成绩与上一份 sync 按现有“各字段保留最好值”规则合并。

完成后 `sdgb_jobs.result` 只保存：

```json
{ "syncId": "...", "scoreCount": 1234 }
```

原始成绩不在 `sdgb_jobs` 重复保存。若用户配置了导入 token，会创建 `trigger=cabinet_qr_update` 的 prober export job；导出失败不回滚 sync。

## 调度参数

当前默认：

```text
SDGB_GET_MUSIC_SCORE_CONCURRENCY=4
SDGB_GET_MUSIC_SCORE_QPS=1
SDGB_GET_MUSIC_SCORE_BURST=4
SDGB_SESSION_CLEANUP_CONCURRENCY=1
SDGB_GET_MUSIC_SCORE_TIMEOUT_MS=180000
SDGB_MIN_SESSION_BEFORE_LOGOUT_MS=60000
```

4/1/4 是单 worker 进程限制。job-start bucket 控制启动频率；每次实际 cabinet API 调用还会经过 global request token bucket。Cleanup 使用独立高优先级并发槽位。

## 已验证事实

- 图片输入、User auth、入队、owner 查询和用户响应脱敏链路已做本地集成测试。
- 一次真实完整流程读取过 3919 条 UserMusicDetail，映射 3831 条 SyncScore；另一个小账号读取 139 条详情、映射 107 条成绩。
- 60 秒版本完成后，任务内 Preview 和任务外独立 Preview 均为 `isLogin=false`、`errorId=0`。
- 完成后 Redis lease 为 0、二维码从 Mongo payload 擦除，临时测试用户和 sync 已清理。
