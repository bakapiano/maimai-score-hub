# DXNet Bot Status 代码事实

本文档根据当前代码实现整理 DXNet bot status 的上报、存储和使用方式。这里的 bot status 指 `bot_statuses` 集合中的 Bot 可用性状态，以及 Worker 随 status report 一起上报、后端写入 `bot_statuses.friends` 的好友列表快照。

## 关键结论

- **Worker 是 bot status 的唯一主动上报方**：每个 DXNet worker 维护一个 bot cookie，并每 60 秒向后端上报一次。
- **`available` 表示 DXNet cookie / session 是否可用，不等于“某用户已是好友”**：用户与 Bot 是否为好友由 `bot_statuses.friends` 里的好友列表快照判断。
- **后端读 status 时会做超时降级**：`BotStatusService.getAll()` 会把 5 分钟未上报的 bot 视为 `available=false`。
- **好友快照是 status report 的 side channel**：Worker 传 `friends` 时，后端 full-overwrite 写入 `bot_statuses.friends`；没有 `friends` 时只更新可用性等状态字段，不覆盖旧快照。
- **所有会挑选 Bot 的后端逻辑都只使用可用 Bot**：并通常按 `friendCount` 低优先，cabinet 场景还要求 `cabinetUserId` 已配置。

## 相关代码入口

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 合约 | `shared/src/modules/admin/admin.contract.ts` | `POST /workers/bots/status`、`GET /admin/bots` 等接口定义 |
| 合约 | `shared/src/modules/admin/admin.schema.ts` | bot status 上报和返回字段 schema |
| Worker | `worker/src/common/bots/background-tasks/status-report.ts` | 周期性抓好友列表并上报 bot status |
| Worker | `worker/src/common/bots/background-tasks/health-check.ts` | 周期性校验 cookie / session，维护本地 `expired` |
| Worker | `worker/src/common/backend/bots.ts` | 调用后端 `reportBotStatus` |
| Worker job | `worker/src/worker/jobs/handlers/get-full-friend-list/stages/get_full_friend_list.ts` | 主动刷新完整好友列表并立刻上报 |
| 后端入口 | `backend/src/api/workers/worker-bots.controller.ts` | 接收 Worker 上报，写 status 和 friend snapshot |
| 后端服务 | `backend/src/modules/bots/services/bot-status.service.ts` | 存储、查询、清理不可用 Bot 任务 |
| 后端服务 | `backend/src/modules/bots/services/bot-friend-snapshot.service.ts` | 好友快照写入和查询 |
| 管理前端 | `frontend/src/pages/admin/AdminActiveJobsPage.tsx` | Bot 状态展示、备注、cabinet 绑定、删除 |
| 用户前端 | `frontend/src/pages/SyncPage.tsx` | 同步前检查当前用户是否已是可用 Bot 好友 |
| ADB worker | `automation/services/bot_monitor.py`、`automation/services/recovery.py` | 拉取后端 bot status，触发 cookie 恢复 |

## 上报数据结构

Worker 上报到：

```http
POST /api/v1/workers/bots/status
X-API-Secret: <API_SHARED_SECRET>

{
  "bots": [
    {
      "friendCode": "336560109012350",
      "available": true,
      "friendCount": 42,
      "friendsUpdatedAt": "2026-06-27T12:00:00.000Z",
      "friends": [
        {
          "friendCode": "123456789012345",
          "userName": "Alice",
          "rating": 15000,
          "avatarUrl": "...",
          "title": "...",
          "titleColor": "...",
          "ratingBgUrl": "...",
          "courseRankUrl": "...",
          "classRankUrl": "...",
          "awakeningCount": 1
        }
      ]
    }
  ]
}
```

`bot_statuses` 保存：

| 字段 | 含义 |
| --- | --- |
| `friendCode` | Bot 的 DXNet 好友码，唯一键 |
| `available` | Worker 当前判断的可用性 |
| `lastReportedAt` | 后端收到本次上报的时间 |
| `friendCount` | 好友数量；本次未上报时保留旧值 |
| `friendsUpdatedAt` | Worker 抓取好友列表的时间；本次未上报时保留旧值 |
| `friends[]` | 该 Bot 好友列表快照，只保存 `friendCode`、`userName`、`rating` |
| `remark` | 管理员备注 |
| `cabinetUserId` | Bot 在 cabinet / sdgb 侧的数字 userId，用于 addRival |

## Worker 上报流程

1. `BotManager` 持有当前 worker 的 `friendCode`、cookie jar、`expired` 标记和内存好友快照。
2. `startBotBackgroundTasks()` 启动 `BotStatusReport`，默认 `runImmediately=true`，之后每 60 秒执行一次。
3. 如果当前没有 bot，直接跳过上报。
4. 如果 `bot.expired=true`，上报 `{ friendCode, available: false }`。
5. 如果内存好友快照存在且距离现在不超过 `BOT_FRIEND_LIST_RECENT_MS`（默认 60 秒），直接用快照上报 `{ available: true, friendCount, friendsUpdatedAt, friends }`。
6. 否则调用 `bot.client.friends.getFriendList()` 抓 DXNet 完整好友列表。成功后更新内存快照并上报完整 status。
7. 如果抓好友列表失败：
   - 有旧内存快照：仍上报 `available=true` 和旧快照；
   - 无旧内存快照：上报 `{ friendCode, available: true }`，不带 `friendCount` / `friends`。
8. 上报失败只打印 `[BotStatusReport] Report error`，不影响 worker 主循环。

`BotHealthCheck` 也默认每 60 秒执行一次，通过 `verifySession()` 检查 cookie。`MaimaiClient` 遇到 cookie 过期会回调 `BotManager._markExpired()`；健康检查成功会 `_markValid()`。Worker 处理 BullMQ job 时也会检查本地 `bot.expired`，过期则延后 job。

## Worker 内存好友快照更新

`BotManager.friendListSnapshots` 是 worker 本地的好友列表快照 store，实现在 `worker/src/common/bots/stores/friend-list-snapshot-store.ts`，status report 优先使用它。

- `getFriendList()` 成功抓完整好友列表时，会 full-overwrite `friendListSnapshots`。
- `isFriendBySearchPage()` 读取好友搜索页；如果 worker 已有完整好友列表快照，会按布尔结果同步修正这份内存快照：
  - `true`：upsert 该 `friendCode` 到内存快照；如果已有完整好友资料，保留旧资料。
  - `false`：从内存快照移除该 `friendCode`。
- `sendFriendRequest()` 成功后记录为非好友，`allowFriendRequest()` 成功后记录为好友，`blockFriendRequest()` / `cancelFriendRequest()` / `removeFriend()` 成功后记录为非好友。
- `allowFriendRequest()` 和 `removeFriend()` 成功时，如果 worker 还没有完整好友列表快照，会触发统一监听器拉取全量好友列表并上报，避免接受/删除好友后必须等下一次 60 秒心跳。
- 内存快照内容发生变化时，会 debounce（默认 1 秒）触发一次统一 `BotStatusReport`，把最新快照上报给后端。
- `get_full_friend_list` job 不再手写 `postBotStatus` payload；它通过 `getFriendList()` 完整覆盖内存快照后，由 `bindBotStatusChangeReportScheduler` 监听快照变化并触发上报。

## 后端接收和状态归一化

`WorkerBotStatusController.reportBotStatus()` 做三件事：

1. 调用 `BotStatusService.report(body.bots)` upsert `bot_statuses`。
2. 对每个包含 `friends` 的 bot，调用 `BotFriendSnapshotService.report()` full-overwrite `bot_statuses.friends`。
3. 将所有上报的 friend rows 交给 `UsersService.patchProfilesFromFriendList()`，best-effort 回填已有用户的 `profile` 字段；失败不会影响心跳返回。

`BotStatusService.report()` 的关键行为：

- `lastReportedAt` 始终设置为后端收到上报的当前时间。
- `friendCount` / `friendsUpdatedAt` 本次没有传时会保留旧值，没有旧值则为 `null`。
- 上报只负责写入状态。

`BotStatusService.getAll()` 返回给调用方前，会按 `REPORT_TIMEOUT_MS=5min` 重新计算可用性：如果 `lastReportedAt` 超过 5 分钟，则返回 `available=false`，即使 DB 中存的是 `true`。

`BotStatusService` 还会每 5 分钟执行一次 stale cleanup：

- 查找 `available=false` 或 `lastReportedAt < now - 5min` 的 Bot。
- 将 `jobs` 中 `botUserFriendCode` 属于不可用 Bot 且 `status in ["queued", "processing"]` 的任务标记为 `failed`，错误为 `Bot Cookie 已过期或不可用`。

## 依赖 bot status 的地方

| 使用点 | 依赖方式 |
| --- | --- |
| `GET /api/v1/admin/bots` | 管理端读取 `BotStatusService.getAll()`，因此会看到 5 分钟超时降级后的 `available`。 |
| 管理前端 `AdminActiveJobsPage` | 展示可用/不可用数量、`friendCount`、备注、`cabinetUserId`、最近上报时间；支持编辑备注、手填或扫码绑定 `cabinetUserId`、删除 bot row。自动刷新开启时每 5 秒重拉一次。 |
| `AuthService.requestLogin(..., method="user_sends_request")` | 读取可用 Bot，按 `friendCount` 升序选择一个 Bot 创建 `accept_friend_request` job；没有可用 Bot 时返回 `当前没有可用的 Bot`。 |
| `JobService.getFriendshipStatus()` | 读取可用 Bot，按 `friendCount` 升序生成候选列表，再用 `bot_statuses.friends` 判断当前用户是否已在某个可用 Bot 好友列表里。 |
| 用户前端 `SyncPage.startSync()` | 先调用 `/me/dxnet-jobs/friendship`；`isFriend=true` 直接创建 `update_score`，否则先创建 `send_friend_request`。 |
| `JobService.create(jobType="update_score")` | 创建成绩更新前调用 `resolveUpdateScoreFriendship()`：只接受可用 Bot 的 snapshot 作为好友关系证据；否则抛 `code="needs_friendship"` 并返回推荐 Bot。 |
| `JobService.create()` cabinet fast-path | 如果用户已有 `cabinetUserId`，会用指定 Bot 的 `cabinetUserId` 或 `pickAvailableCabinetBot()` 调 sdgb `addRival`；成功后可直接进入 `update_score`。 |
| `BotStatusService.pickAvailableCabinetBot()` | 只挑 `available=true && cabinetUserId != null` 的 Bot，并按 `friendCount + 当前 queued/processing in-flight job 数` 最小排序。 |
| `QrLoginService` slow path | 先 `pickAvailableCabinetBot()`，用 sdgb `addRival`，再创建 `get_full_friend_list` job 刷新同一个 Bot 的 snapshot，最后用 `(userName, rating)` 在新 snapshot 中反查 friendCode。 |
| `AutoUpdateSchedulerService.maybeEnqueueFcfs()` | FC/FS enrichment 需要 `pickAvailableCabinetBot()`，随后 sdgb `addRival` 并创建 `get_user_recent_event` DXNet job。 |
| `Worker get_full_friend_list` job | 主动抓完整好友列表，通过 `getFriendList()` full-overwrite BotManager 内存快照；快照变化后由统一监听器触发 bot status report，刷新 `bot_statuses`。 |
| `BotStatusService.cleanupStaleJobs()` | 定期根据不可用/超时 Bot fail 掉已分配给这些 Bot 的 queued/processing job。 |
| `AdminAutoUpdateMetricsService.getAutoUpdateMetrics()` | 直接统计 `bot_statuses` 中 `available=true && cabinetUserId != null` 的 Bot 数，用于自动更新容量估算。 |
| ADB worker `bot_monitor` / `recovery` | 通过 `GET /api/v1/admin/bots` 拉取状态，缓存后找出 `available=false` 的 Bot；若本地有设备绑定且满足恢复间隔，就触发 WeChat WebView cookie recovery。 |

## 前端如何判断“用户是否已和 DXNet Bot 成为好友”

用户点击同步时，`SyncPage.startSync()` 调用：

```http
GET /api/v1/me/dxnet-jobs/friendship
Authorization: Bearer <token>
```

后端 `JobService.getFriendshipStatus(friendCode)` 的判断流程：

1. 读取所有 Bot status。
2. 过滤 `available=true` 的 Bot，并按 `friendCount` 从小到大排序。
3. 取可用 Bot 的 `friendCode` 列表。
4. 在 `bot_statuses.friends` 中查找任一可用 Bot 的 `friends.friendCode == 当前用户 friendCode`。
5. 如果找到：
   - `isFriend=true`
   - `botFriendCode=<命中的 Bot>`
   - `recommendedBotFriendCode=<命中的 Bot>`
   - `friendsUpdatedAt=<该 Bot snapshot 更新时间>`
6. 如果没找到：
   - `isFriend=false`
   - `botFriendCode=null`
   - `recommendedBotFriendCode=<friendCount 最低的可用 Bot>`，没有可用 Bot 则为 `null`
   - `friendsUpdatedAt=null`

前端只看 `isFriend` 决定下一步：已是好友就创建 `update_score`；否则创建 `send_friend_request`，等待用户接受好友申请后再用完成的 `friendshipJobId` 创建 `update_score`。这个 `friendshipJobId` 是为了在好友快照尚未等到下一次心跳刷新时，仍能用刚完成的好友申请 job 作为短期证明。

## 注意事项

- `friendCount` 只是 Worker 最近一次可用快照的负载指标；它不是强一致计数。`pickAvailableCabinetBot()` 会额外加上当前已分配的 queued/processing job 数，降低连续挑中同一个 Bot 的概率。
- `available=false` 主要代表 cookie 过期或 worker 超时未上报；它不表示该 Bot 已从 DXNet 删除好友。
- `bot_statuses.friends` 只有在 Worker 成功拿到好友列表并随 status report 发送 `friends` 时才更新；普通 status report 可以只更新可用性而不刷新 snapshot。
- 管理端删除 Bot row 没有黑名单语义：如果 worker 仍在运行，下一次 60 秒心跳会重新创建 `bot_statuses` row。
