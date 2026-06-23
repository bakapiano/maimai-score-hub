# DB 类型整理

本文档整理 backend 当前由 Mongoose 管理的 MongoDB 类型。来源以 `backend/src/modules/**/*.schema.ts` 为准。

## 基础约定

- 数据库：`MONGO_DB`，默认 `maimai_web`。
- 模型：均通过 `@nestjs/mongoose` + `SchemaFactory.createForClass(...)` 注册。
- 文档类型：每个 schema 都导出 `HydratedDocument<Entity>` 形式的 `*Document` 类型。
- 时间字段：`@Schema({ timestamps: true })` 会自动维护 `createdAt` / `updatedAt`；未启用 timestamps 的 schema 若有时间字段，会在字段表里标明。
- 半结构字段：`Mixed`、`Object`、`Record<string, unknown>` 字段用于保存外部接口 payload/result 或导入结果，实际 shape 由业务代码约束。

## 集合总览

| Entity                    | Collection                                 | 模块        | 保留期    | 用途                                     |
| ------------------------- | ------------------------------------------ | ----------- | --------- | ---------------------------------------- |
| `UserEntity`              | Mongoose 隐式集合名，通常为 `userentities` | users       | 永久      | 用户、导入 token、机台绑定、自动更新状态 |
| `SyncEntity`              | `syncs`                                    | sync        | 永久      | 一次成绩同步结果                         |
| `MusicEntity`             | `musics`                                   | music       | 永久      | 乐曲与谱面元数据                         |
| `MusicConfigEntity`       | `music_config`                             | music       | 永久      | 乐曲数据源配置                           |
| `JobEntity`               | `jobs`                                     | job         | 7 天 TTL  | DXNet worker 任务                        |
| `QrLoginAttemptEntity`    | `qr_login_attempts`                        | auth        | 1 天 TTL  | QR 登录异步尝试                          |
| `BotStatusEntity`         | `bot_statuses`                             | admin       | 永久      | DXNet bot 可用性和好友数                 |
| `BotFriendSnapshotEntity` | `bot_friend_snapshots`                     | admin       | 30 天 TTL | bot 好友列表快照                         |
| `NotifyStateEntity`       | `notify_state`                             | admin       | 永久      | 多实例通知去重状态                       |
| `SystemSettingsEntity`    | `system_settings`                          | admin       | 永久      | 全局系统配置                             |
| `AutoUpdateRunEntity`     | `auto_update_runs`                         | auto-update | 30 天 TTL | 自动更新 cron 每轮执行记录               |
| `SdgbJobEntity`           | `sdgb_jobs`                                | sdgb-worker | 1 天 TTL  | sdgb-worker 机台协议任务                 |

## Redis Runtime 数据

下列短生命周期运行态数据不再由 MongoDB 管理：

| Key 模式                                 | 保留期                                    | 用途                                      |
| ---------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `logs:worker:dxnet` / `logs:worker:sdgb` | `WORKER_LOG_STREAM_MAXLEN` 限长           | worker 控制台日志 Redis Stream            |
| `status:worker:sdgb:{workerId}`          | 约 `SDGB_WORKER_STALE_MS * 2`             | sdgb-worker 心跳和启动后 claim 计数       |
| `cache:job-temp:{jobId}:{diff}:{type}`   | `JOB_TEMP_CACHE_TTL_SECONDS`，默认 1 小时 | `update_score` 中间结果缓存               |
| `debug:api:{jobId}`                      | `API_DEBUG_TTL_SECONDS`，默认 24 小时     | worker API 调用 metadata，不保存 raw body |

## Users

来源：`backend/src/modules/users/user.schema.ts`

### `UserEntity`

| 字段                      | 类型                     | 约束 / 默认值                | 说明                                 |
| ------------------------- | ------------------------ | ---------------------------- | ------------------------------------ |
| `friendCode`              | `string`                 | required, unique, index      | 用户好友码，主业务标识               |
| `divingFishImportToken`   | `string \| null`         | default `null`               | Diving Fish 导入 token               |
| `lxnsImportToken`         | `string \| null`         | default `null`               | LXNS 导入 token                      |
| `profile`                 | `UserNetProfile \| null` | `Mixed`, default `undefined` | DXNet 用户资料缓存                   |
| `idleUpdateBotFriendCode` | `string \| null`         | default `null`               | 空闲更新使用的 bot                   |
| `autoExportDivingFish`    | `boolean`                | default `false`              | 同步后自动导出到 Diving Fish         |
| `autoExportLxns`          | `boolean`                | default `false`              | 同步后自动导出到 LXNS                |
| `lastActiveAt`            | `Date \| null`           | default `null`               | 最近活跃时间                         |
| `preferredBotFriendCode`  | `string \| null`         | default `null`               | 用户偏好的 bot                       |
| `cabinetUserId`           | `number \| null`         | default `null`               | 机台侧数字 userId，`null` 表示未绑定 |
| `autoUpdate`              | `boolean`                | default `false`              | 是否参与自动更新                     |
| `lastScoreHash`           | `string \| null`         | default `null`               | 上次观测到的机台成绩 hash            |
| `lastHashCheckAt`         | `Date \| null`           | default `null`               | 上次拉取 hash 的时间                 |
| `lastAutoUpdateJobAt`     | `Date \| null`           | default `null`               | 上次创建自动更新 job 的时间          |
| `autoUpdateFailureCount`  | `number`                 | default `0`                  | 自动更新 job 连续失败次数            |
| `autoUpdateBackoffUntil`  | `Date \| null`           | default `null`               | 自动更新退避截止时间                 |
| `createdAt`               | `Date`                   | timestamps                   | 创建时间                             |
| `updatedAt`               | `Date`                   | timestamps                   | 更新时间                             |

嵌套类型：

```ts
interface UserNetProfile {
  avatarUrl: string | null;
  title: string | null;
  titleColor: string | null;
  username: string | null;
  rating: number | null;
  ratingBgUrl: string | null;
  courseRankUrl: string | null;
  classRankUrl: string | null;
  awakeningCount: number | null;
}
```

索引：

- `friendCode`：唯一索引。
- `{ autoUpdate: 1, cabinetUserId: 1 }`，名称 `auto_update_cabinet`。
- `{ createdAt: -1 }`，名称 `createdAt_desc`。

## Sync

来源：`backend/src/modules/sync/sync.schema.ts`

### `SyncEntity`

| 字段               | 类型                       | 约束 / 默认值           | 说明               |
| ------------------ | -------------------------- | ----------------------- | ------------------ |
| `id`               | `string`                   | required, unique, index | 同步记录 id        |
| `jobId`            | `string`                   | required, index         | 来源 job id        |
| `friendCode`       | `string`                   | required                | 用户好友码         |
| `scores`           | `SyncScore[]`              | default `[]`            | 本次同步的成绩列表 |
| `autoExportResult` | `AutoExportResult \| null` | default `null`          | 自动导出结果       |
| `createdAt`        | `Date`                     | timestamps              | 创建时间           |
| `updatedAt`        | `Date`                     | timestamps              | 更新时间           |

嵌套类型：

```ts
type SyncScore = {
  musicId: string;
  cid: string;
  chartIndex: number;
  type: string;
  dxScore: string | null;
  score: string | null;
  fs: string | null;
  fc: string | null;
  rating: number | null;
  isNew: boolean | null;
};

type AutoExportResult = {
  divingFish?: { status: string; message?: string } | null;
  lxns?: { status: string; message?: string } | null;
};
```

索引：

- `id`：唯一索引。
- `jobId`：单字段索引。
- `{ friendCode: 1, createdAt: -1 }`，名称 `by_fc_recent`。

## Music

来源：`backend/src/modules/music/music.schema.ts`、`backend/src/modules/music/music-config.schema.ts`

### `MusicEntity`

| 字段        | 类型                       | 约束 / 默认值           | 说明                        |
| ----------- | -------------------------- | ----------------------- | --------------------------- |
| `id`        | `string`                   | required, unique, index | 乐曲 id                     |
| `title`     | `string`                   | required                | 标题                        |
| `type`      | `string`                   | required                | 谱面类型，如 SD / DX 来源值 |
| `artist`    | `string \| null`           | default `null`          | 曲师                        |
| `category`  | `string \| null`           | default `null`          | 分类                        |
| `bpm`       | `number \| string \| null` | `Mixed`, default `null` | BPM                         |
| `version`   | `string \| null`           | default `null`          | 版本                        |
| `isNew`     | `boolean \| null`          | default `null`          | 是否新曲                    |
| `charts`    | `ChartPayload[]`           | `Mixed`, default `[]`   | 谱面列表                    |
| `sync`      | `MusicSyncInfo \| null`    | default `null`          | 乐曲源同步信息              |
| `createdAt` | `Date`                     | timestamps              | 创建时间                    |
| `updatedAt` | `Date`                     | timestamps              | 更新时间                    |

嵌套类型：

```ts
type ChartNotesSD = {
  tap: number;
  hold: number;
  slide: number;
  break: number;
};

type ChartNotesDX = ChartNotesSD & {
  touch: number;
};

type ChartNotes = ChartNotesSD | ChartNotesDX;

type ChartPayload = {
  cid?: string;
  level?: string;
  detailLevel?: number;
  notes?: unknown;
  charter?: string;
};

type MusicSyncInfo = {
  createdAt?: Date | null;
  updatedAt?: Date | null;
  lastSyncedAt?: Date | null;
};

interface SongMetadata {
  title?: string;
  artist?: string;
  category?: string;
  bpm?: number | string | null;
  from?: string | null;
  isNew?: boolean;
}
```

索引：

- `id`：唯一索引。

### `MusicConfigEntity`

| 字段         | 类型                      | 约束 / 默认值                       | 说明       |
| ------------ | ------------------------- | ----------------------------------- | ---------- |
| `key`        | `string`                  | required, unique, default `default` | 配置键     |
| `dataSource` | `'diving-fish' \| 'lxns'` | required, default `diving-fish`     | 乐曲数据源 |
| `createdAt`  | `Date`                    | timestamps                          | 创建时间   |
| `updatedAt`  | `Date`                    | timestamps                          | 更新时间   |

索引：

- `key`：唯一索引。

## DXNet Jobs

来源：`backend/src/modules/job/job.schema.ts`、`backend/src/modules/job/job.types.ts`

### `JobEntity`

| 字段                         | 类型                                                               | 约束 / 默认值                           | 说明                                 |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------- | ------------------------------------ |
| `id`                         | `string`                                                           | required, unique, index                 | job id                               |
| `friendCode`                 | `string`                                                           | required                                | 目标用户好友码                       |
| `jobType`                    | `JobType`                                                          | required, default `send_friend_request` | job 类型                             |
| `priority`                   | `number`                                                           | required, default `0`                   | 调度优先级                           |
| `skipUpdateScore`            | `boolean`                                                          | required, default `false`               | 是否跳过更新成绩                     |
| `botUserFriendCode`          | `string \| null`                                                   | default `null`                          | 执行 bot 好友码                      |
| `friendRequestSentAt`        | `string \| null`                                                   | default `null`                          | 好友请求发送时间                     |
| `friendRequestWaitStartedAt` | `string \| null`                                                   | default `null`                          | 等待好友请求开始时间                 |
| `status`                     | `JobStatus`                                                        | required                                | job 状态                             |
| `stage`                      | `JobStage`                                                         | required                                | 当前阶段                             |
| `result`                     | `any`                                                              | `Mixed`, default `undefined`            | 执行结果                             |
| `profile`                    | `UserNetProfile`                                                   | `Mixed`, default `undefined`            | 任务得到的用户资料                   |
| `error`                      | `string \| null`                                                   | default `null`                          | 错误信息                             |
| `executing`                  | `boolean`                                                          | required, default `false`               | 是否已被 worker claim                |
| `scoreProgress`              | `ScoreProgress \| null`                                            | `Mixed`, default `null`                 | 成绩更新进度                         |
| `updateScoreDuration`        | `number \| null`                                                   | default `null`                          | `update_score` 耗时                  |
| `autoExportResult`           | `AutoExportResult \| null`                                         | `Mixed`, default `null`                 | 自动导出结果                         |
| `isAuthenticated`            | `boolean`                                                          | required, default `false`               | 是否已认证                           |
| `sourceScoreHash`            | `string \| null`                                                   | default `null`                          | 自动更新创建 job 时观测到的成绩 hash |
| `cabinetScoreMap`            | `Record<string, { achievement: number; dxScore: number }> \| null` | `Mixed`, default `null`                 | 自动更新从机台侧拿到的成绩 map       |
| `diffsToScrape`              | `number[] \| null`                                                 | default `null`                          | 限定 worker 抓取的难度               |
| `runAt`                      | `Date \| null`                                                     | default `null`                          | 下次允许 claim 的时间                |
| `createdAt`                  | `Date`                                                             | required                                | 创建时间                             |
| `updatedAt`                  | `Date`                                                             | required                                | 更新时间                             |

枚举和嵌套类型：

```ts
type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';

type JobStage =
  | 'send_request'
  | 'wait_acceptance'
  | 'wait_user_request'
  | 'accept_request'
  | 'update_score'
  | 'get_user_recent_event';

type JobType =
  | 'send_friend_request'
  | 'accept_friend_request'
  | 'update_score'
  | 'get_user_recent_event';

interface ScoreProgress {
  completedDiffs: number[];
  totalDiffs: number;
}
```

索引：

- `id`：唯一索引。
- `{ createdAt: 1 }`：TTL 7 天。
- `{ status: 1, botUserFriendCode: 1, executing: 1 }`，名称 `hot_claim`。
- `{ executing: 1, updatedAt: 1 }`，名称 `stale_lock`。
- `{ status: 1, botUserFriendCode: 1, executing: 1, runAt: 1 }`，名称 `hot_claim_due`。
- `{ status: 1, botUserFriendCode: 1, executing: 1, runAt: 1, priority: -1, updatedAt: 1 }`，名称 `hot_claim_priority`。
- `{ botUserFriendCode: 1, status: 1 }`，名称 `bot_status`。
- `{ skipUpdateScore: 1, status: 1, createdAt: 1 }`，名称 `admin_stats_status_createdAt`。
- `{ skipUpdateScore: 1, status: 1, updateScoreDuration: 1, createdAt: 1 }`，名称 `admin_stats_duration`。
- `{ jobType: 1, friendCode: 1, createdAt: -1 }`，名称 `latest_by_type_friend`。
- `{ status: 1, createdAt: -1 }`，名称 `status_createdAt_desc`。

## Auth

来源：`backend/src/modules/auth/qr-login-attempt.schema.ts`

### `QrLoginAttemptEntity`

| 字段                 | 类型             | 约束 / 默认值           | 说明                         |
| -------------------- | ---------------- | ----------------------- | ---------------------------- |
| `id`                 | `string`         | required, unique, index | 尝试 id                      |
| `status`             | `QrLoginStatus`  | required                | 当前状态                     |
| `cabinetUserId`      | `number`         | required                | 扫码得到的机台 userId        |
| `rivalName`          | `string \| null` | default `null`          | 机台侧用户名                 |
| `computedRating`     | `number \| null` | default `null`          | 计算得到的 rating            |
| `botUserFriendCode`  | `string \| null` | default `null`          | 执行匹配的 bot               |
| `resolvedFriendCode` | `string \| null` | default `null`          | 匹配成功后的用户好友码       |
| `token`              | `string \| null` | default `null`          | 匹配成功后返回给前端的 token |
| `error`              | `string \| null` | default `null`          | 失败原因                     |
| `createdAt`          | `Date`           | timestamps              | 创建时间                     |
| `updatedAt`          | `Date`           | timestamps              | 更新时间                     |

枚举：

```ts
type QrLoginStatus =
  | 'pending'
  | 'adding_rival'
  | 'waiting_snapshot'
  | 'matched'
  | 'failed';
```

索引：

- `id`：唯一索引。
- `{ createdAt: 1 }`：TTL 1 天。

## Admin

来源：`backend/src/modules/admin/*.schema.ts`

### `BotStatusEntity`

| 字段                  | 类型             | 约束 / 默认值           | 说明                  |
| --------------------- | ---------------- | ----------------------- | --------------------- |
| `friendCode`          | `string`         | required, unique, index | bot 好友码            |
| `available`           | `boolean`        | required                | 是否可用              |
| `lastReportedAt`      | `Date`           | required                | 最近上报时间          |
| `friendCount`         | `number \| null` | default `null`          | 好友数                |
| `friendsUpdatedAt`    | `Date \| null`   | default `null`          | 好友列表更新时间      |
| `remark`              | `string \| null` | default `null`          | 管理备注              |
| `notifiedUnavailable` | `boolean`        | default `false`         | 是否已发送不可用通知  |
| `cabinetUserId`       | `number \| null` | default `null`          | bot 对应的机台 userId |

索引：

- `friendCode`：唯一索引。

### `BotFriendSnapshotEntity`

| 字段            | 类型                        | 约束 / 默认值           | 说明             |
| --------------- | --------------------------- | ----------------------- | ---------------- |
| `botFriendCode` | `string`                    | required, unique, index | bot 好友码       |
| `friends`       | `BotFriendSnapshotFriend[]` | default `[]`            | bot 当前好友列表 |
| `updatedAt`     | `Date`                      | required                | 快照更新时间     |

嵌套类型：

```ts
type BotFriendSnapshotFriend = {
  friendCode: string;
  userName: string | null;
  rating: number | null;
};
```

索引：

- `botFriendCode`：唯一索引。
- `{ updatedAt: 1 }`：TTL 30 天。

### `NotifyStateEntity`

| 字段             | 类型           | 约束 / 默认值             | 说明                             |
| ---------------- | -------------- | ------------------------- | -------------------------------- |
| `key`            | `string`       | required, unique, index   | 通知类型标识，如 `all_bots_down` |
| `notified`       | `boolean`      | required, default `false` | 是否已发送通知                   |
| `lastNotifiedAt` | `Date \| null` | default `null`            | 上次发送通知时间                 |

索引：

- `key`：唯一索引。

### `SystemSettingsEntity`

| 字段              | 类型      | 约束 / 默认值                       | 说明                       |
| ----------------- | --------- | ----------------------------------- | -------------------------- |
| `key`             | `string`  | required, unique, default `default` | 配置键                     |
| `cabinetOnlyMode` | `boolean` | required, default `false`           | 是否启用 cabinet-only 模式 |
| `createdAt`       | `Date`    | timestamps                          | 创建时间                   |
| `updatedAt`       | `Date`    | timestamps                          | 更新时间                   |

索引：

- `key`：唯一索引。

## Auto Update

来源：`backend/src/modules/auto-update/auto-update-run.schema.ts`

### `AutoUpdateRunEntity`

| 字段              | 类型                       | 约束 / 默认值           | 说明                                     |
| ----------------- | -------------------------- | ----------------------- | ---------------------------------------- |
| `bucketKey`       | `string`                   | required, unique, index | cron bucket，格式类似 `YYYY-MM-DDTHH:MM` |
| `triggeredAt`     | `Date`                     | required                | 触发时间                                 |
| `ranOn`           | `string`                   | default `unknown`       | 赢得本轮 sweep 的实例                    |
| `status`          | `'running' \| 'completed'` | default `running`       | 执行状态                                 |
| `totalUsers`      | `number`                   | default `0`             | 本轮候选用户数                           |
| `triggered`       | `number`                   | default `0`             | 触发更新 job 数                          |
| `skippedNoChange` | `number`                   | default `0`             | hash 未变化跳过数                        |
| `failed`          | `number`                   | default `0`             | 失败数                                   |

索引：

- `bucketKey`：唯一索引。
- `{ triggeredAt: 1 }`：TTL 30 天。

## SDGB Worker

来源：`backend/src/modules/sdgb-worker/*.schema.ts`

### `SdgbJobEntity`

| 字段           | 类型                              | 约束 / 默认值           | 说明                  |
| -------------- | --------------------------------- | ----------------------- | --------------------- |
| `id`           | `string`                          | required, unique, index | sdgb job id           |
| `jobType`      | `SdgbJobType`                     | required, index         | 机台协议任务类型      |
| `status`       | `SdgbJobStatus`                   | required, index         | job 状态              |
| `payload`      | `Record<string, unknown>`         | `Mixed`, required       | job 输入              |
| `result`       | `Record<string, unknown> \| null` | `Mixed`, default `null` | job 结果              |
| `error`        | `string \| null`                  | default `null`          | 错误信息              |
| `executing`    | `boolean`                         | default `false`         | 是否已被 worker claim |
| `claimedAt`    | `Date \| null`                    | default `null`          | claim 时间            |
| `requesterTag` | `string \| null`                  | default `null`, index   | 生产者自定义追踪 tag  |
| `createdAt`    | `Date`                            | timestamps              | 创建时间              |
| `updatedAt`    | `Date`                            | timestamps              | 更新时间              |

枚举和 payload/result 约定：

```ts
type SdgbJobType = 'scan_qr' | 'get_rival_hash' | 'add_rival';
type SdgbJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

type SdgbJobPayload =
  | { qrCode: string; callerUid?: number }
  | { cabinetUserId: number; callerUid?: number }
  | { botCabinetUserId: number; targetCabinetUserId: number };

type SdgbJobResult =
  | { cabinetUserId: number; music: unknown[]; hash: string }
  | { hash: string; music: unknown[] }
  | { returnCode1: number; returnCode2: number };
```

索引：

- `id`：唯一索引。
- `jobType`：单字段索引。
- `status`：单字段索引。
- `requesterTag`：单字段索引。
- `{ createdAt: 1 }`：TTL 1 天。
- `{ status: 1, jobType: 1 }`，名称 `status_type`。
- `{ jobType: 1, requesterTag: 1, createdAt: -1 }`，名称 `by_requester`。
- `{ status: 1, createdAt: 1 }`，名称 `status_createdAt`。
- `{ status: 1, claimedAt: 1 }`，名称 `status_claimedAt`。
- `{ updatedAt: -1 }`，名称 `updatedAt_desc`。

## Document 类型清单

| Document 类型               | Entity                    |
| --------------------------- | ------------------------- |
| `UserDocument`              | `UserEntity`              |
| `SyncDocument`              | `SyncEntity`              |
| `MusicDocument`             | `MusicEntity`             |
| `MusicConfigDocument`       | `MusicConfigEntity`       |
| `JobDocument`               | `JobEntity`               |
| `QrLoginAttemptDocument`    | `QrLoginAttemptEntity`    |
| `BotStatusDocument`         | `BotStatusEntity`         |
| `BotFriendSnapshotDocument` | `BotFriendSnapshotEntity` |
| `NotifyStateDocument`       | `NotifyStateEntity`       |
| `SystemSettingsDocument`    | `SystemSettingsEntity`    |
| `AutoUpdateRunDocument`     | `AutoUpdateRunEntity`     |
| `SdgbJobDocument`           | `SdgbJobEntity`           |
