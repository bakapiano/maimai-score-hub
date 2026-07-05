# DB 类型整理

本文档整理 backend 当前由 Mongoose 管理的 MongoDB 类型。来源以 `backend/src/modules/**/*.schema.ts` 为准。

## 基础约定

- 数据库：`MONGO_DB`，默认 `maimai_web`。
- 模型：均通过 `@nestjs/mongoose` + `SchemaFactory.createForClass(...)` 注册。
- 文档类型：每个 schema 都导出 `HydratedDocument<Entity>` 形式的 `*Document` 类型。
- 时间字段：`@Schema({ timestamps: true })` 会自动维护 `createdAt` / `updatedAt`；未启用 timestamps 的 schema 若有时间字段，会在字段表里标明。
- 半结构字段：`Mixed`、`Object`、`Record<string, unknown>` 字段用于保存外部接口 payload/result 或导入结果，实际 shape 由业务代码约束。

## 集合总览

| Entity                       | Collection                                 | 模块          | 保留期    | 用途                                               |
| ---------------------------- | ------------------------------------------ | ------------- | --------- | -------------------------------------------------- |
| `UserEntity`                 | Mongoose 隐式集合名，通常为 `userentities` | users         | 永久      | 用户、密码登录、导入 token、机台绑定、自动更新开关 |
| `SyncEntity`                 | `syncs`                                    | sync          | 永久      | 一次成绩同步结果                                   |
| `MusicEntity`                | `musics`                                   | music         | 永久      | 乐曲与谱面元数据                                   |
| `JobEntity`                  | `jobs`                                     | job           | 7 天 TTL  | DXNet worker 任务                                  |
| `ProberExportJobEntity`      | `prober_export_jobs`                       | prober-export | 永久      | Diving-Fish / LXNS 导出任务与结果                  |
| `QrLoginAttemptEntity`       | `qr_login_attempts`                        | auth          | 1 天 TTL  | QR 登录异步尝试                                    |
| `BotStatusEntity`            | `bot_statuses`                             | admin         | 永久      | DXNet bot 可用性和好友数                           |
| `AutoUpdateRunEntity`        | `auto_update_runs`                         | auto-update   | 30 天 TTL | 自动更新 cron 每轮执行记录                         |
| `AutoUpdateProbeStateEntity` | `auto_update_probe_states`                 | auto-update   | 永久      | Rival-first 自动更新用户状态                       |
| `AutoUpdateTaskEntity`       | `auto_update_tasks`                        | auto-update   | 3 天 TTL  | Rival-first 自动更新短期任务日志                   |
| `SdgbJobEntity`              | `sdgb_jobs`                                | sdgb-worker   | 1 天 TTL  | sdgb-worker 机台协议任务                           |

## Redis Runtime 数据

下列短生命周期运行态数据不再由 MongoDB 管理：

| Key 模式                               | 保留期                                    | 用途                        |
| -------------------------------------- | ----------------------------------------- | --------------------------- |
| `status:worker:sdgb:{workerId}`        | 约 `SDGB_WORKER_STALE_MS * 2`             | sdgb-worker 心跳和处理计数  |
| `cache:job-temp:{jobId}:{diff}:{type}` | `JOB_TEMP_CACHE_TTL_SECONDS`，默认 1 小时 | `update_score` 中间结果缓存 |

## Users

来源：`backend/src/modules/users/schemas/user.schema.ts`

### `UserEntity`

| 字段                    | 类型                     | 约束 / 默认值                | 说明                                     |
| ----------------------- | ------------------------ | ---------------------------- | ---------------------------------------- |
| `friendCode`            | `string`                 | required, unique, index      | 用户好友码，主业务标识                   |
| `username`              | `string \| null`         | default `null`               | 密码登录用户名，唯一 sparse/partial 索引 |
| `passwordHash`          | `string \| null`         | default `null`, select false | scrypt 密码 hash                         |
| `passwordUpdatedAt`     | `Date \| null`           | default `null`               | 密码最近更新时间                         |
| `divingFishImportToken` | `string \| null`         | default `null`               | Diving Fish 导入 token                   |
| `lxnsImportToken`       | `string \| null`         | default `null`               | LXNS 导入 token                          |
| `profile`               | `UserNetProfile \| null` | `Mixed`, default `undefined` | DXNet 用户资料缓存                       |
| `lastActiveAt`          | `Date \| null`           | default `null`               | 最近活跃时间                             |
| `cabinetUserId`         | `number \| null`         | default `null`               | 机台侧数字 userId，`null` 表示未绑定     |
| `autoUpdate`            | `boolean`                | default `false`              | 是否参与自动更新                         |
| `createdAt`             | `Date`                   | timestamps                   | 创建时间                                 |
| `updatedAt`             | `Date`                   | timestamps                   | 更新时间                                 |

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
- `username`：唯一 partial index，名称 `username_unique`，仅索引 string。
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

## Prober Export Jobs

来源：`backend/src/modules/prober-export/schemas/prober-export-job.schema.ts`

### `ProberExportJobEntity`

| 字段           | 类型             | 约束 / 默认值           | 说明                                                                            |
| -------------- | ---------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `id`           | `string`         | required, unique, index | 导出任务 id                                                                     |
| `trigger`      | `string`         | required, index         | `dxnet_update_score` / `auto_update_rival` / `auto_update_fcfs` / `manual`      |
| `friendCode`   | `string`         | required, index         | 用户好友码                                                                      |
| `syncId`       | `string`         | required, index         | 要导出的固定 sync 快照                                                          |
| `sourceJobId`  | `string \| null` | default `null`          | 来源 DXNet job id                                                               |
| `sourceTaskId` | `string \| null` | default `null`          | 来源 auto-update task id                                                        |
| `targets`      | `string[]`       | default `[]`            | `divingFish` / `lxns`                                                           |
| `status`       | `string`         | required, index         | `queued` / `processing` / `completed` / `partial_failed` / `failed` / `skipped` |
| `attempts`     | `number`         | default `0`             | worker claim 次数                                                               |
| `result`       | `Object \| null` | default `null`          | 每个 provider 的完整导出结果                                                    |
| `error`        | `string \| null` | default `null`          | job 级错误                                                                      |
| `claimedAt`    | `Date \| null`   | default `null`          | worker claim 时间                                                               |
| `completedAt`  | `Date \| null`   | default `null`          | 完成时间                                                                        |
| `createdAt`    | `Date`           | timestamps              | 创建时间                                                                        |
| `updatedAt`    | `Date`           | timestamps              | 更新时间                                                                        |

索引：

- `id`：唯一索引。
- `{ trigger: 1, sourceJobId: 1 }`：partial unique，防止同一来源 DXNet job 重复 enqueue。
- `{ trigger: 1, sourceTaskId: 1 }`：partial unique，防止同一 auto-update task 重复 enqueue。
- `{ syncId: 1, trigger: 1 }`。
- `{ friendCode: 1, createdAt: -1 }`。
- `{ status: 1, createdAt: 1 }`。
- `{ status: 1, claimedAt: 1 }`。

## Music

来源：`backend/src/modules/music/schemas/music.schema.ts`

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

## DXNet Jobs

来源：`backend/src/modules/job/job.schema.ts`、`backend/src/modules/job/job.types.ts`

### `JobEntity`

| 字段                         | 类型                    | 约束 / 默认值                           | 说明                                     |
| ---------------------------- | ----------------------- | --------------------------------------- | ---------------------------------------- |
| `id`                         | `string`                | required, unique, index                 | job id                                   |
| `friendCode`                 | `string`                | required                                | 目标用户好友码                           |
| `jobType`                    | `JobType`               | required, default `send_friend_request` | job 类型                                 |
| `priority`                   | `number`                | required, default `0`                   | 调度优先级                               |
| `botUserFriendCode`          | `string \| null`        | default `null`                          | 执行 bot 好友码                          |
| `friendRequestSentAt`        | `string \| null`        | default `null`                          | 好友请求发送时间                         |
| `friendRequestWaitStartedAt` | `string \| null`        | default `null`                          | 等待好友请求开始时间                     |
| `status`                     | `JobStatus`             | required                                | job 状态                                 |
| `stage`                      | `JobStage`              | required                                | 当前阶段                                 |
| `result`                     | `any`                   | `Mixed`, default `undefined`            | 执行结果                                 |
| `profile`                    | `UserNetProfile`        | `Mixed`, default `undefined`            | 任务得到的用户资料                       |
| `error`                      | `string \| null`        | default `null`                          | 错误信息                                 |
| `scoreProgress`              | `ScoreProgress \| null` | `Mixed`, default `null`                 | 成绩更新进度                             |
| `updateScoreDuration`        | `number \| null`        | default `null`                          | `update_score` 耗时                      |
| `diffsToScrape`              | `number[] \| null`      | default `null`                          | 指定 `update_score` 只抓取的难度列表     |
| `context`                    | `JobContext \| null`    | `Mixed`, default `null`                 | 内部链路上下文，见下方 `JobContext`      |
| `removeFriendAfterComplete`  | `boolean`               | default `false`                         | job 成功完成后由 worker 异步删除目标好友 |
| `runAt`                      | `Date \| null`          | default `null`                          | 下次允许 BullMQ 投递的时间               |
| `createdAt`                  | `Date`                  | required                                | 创建时间                                 |
| `updatedAt`                  | `Date`                  | required                                | 更新时间                                 |

枚举和嵌套类型：

```ts
type JobStatus = "queued" | "processing" | "completed" | "failed" | "canceled";

type JobStage =
  | "send_request"
  | "wait_acceptance"
  | "wait_user_request"
  | "accept_request"
  | "update_score"
  | "get_user_recent_event"
  | "get_full_friend_list";

type JobType =
  | "send_friend_request"
  | "accept_friend_request"
  | "update_score"
  | "get_user_recent_event"
  | "get_full_friend_list";

interface ScoreProgress {
  completedDiffs: number[];
  totalDiffs: number;
}

type JobContext =
  | null
  | {
      // AutoUpdateSchedulerService.maybeEnqueueFcfs() 创建的
      // get_user_recent_event job，用于补最近 FC/FS。
      autoUpdateFcfs: true;
      reason: "rival_hash_changed" | "map_delta" | "manual";
    }
  | {
      // 用户活动稳定后自动创建的全量 update_score。
      source: "auto_update_settled_full_update";
      lastActivityAt: string | null; // ISO timestamp
    };
```

`context` 当前取值：

| jobType                 | 场景                                   | context                                                   |
| ----------------------- | -------------------------------------- | --------------------------------------------------------- |
| `send_friend_request`   | 登录 / 建好友关系                      | `null`                                                    |
| `accept_friend_request` | 用户主动加 Bot 登录                    | `null`                                                    |
| `update_score`          | 用户手动同步 / 普通成绩更新            | `null`                                                    |
| `update_score`          | 稳定后全量自动更新                     | `{ source, lastActivityAt }`                              |
| `get_user_recent_event` | 自动更新 FC/FS enrichment              | `{ autoUpdateFcfs: true, reason }`；通常 `runAt=now+3min` |
| `get_full_friend_list`  | QR-login slow path 主动刷新 Bot 好友表 | `null`                                                    |

索引：

- `id`：唯一索引。
- `{ createdAt: 1 }`：TTL 7 天。
- `{ botUserFriendCode: 1, status: 1 }`，名称 `bot_status`。
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
  "pending" | "adding_rival" | "waiting_snapshot" | "matched" | "failed";
```

索引：

- `id`：唯一索引。
- `{ createdAt: 1 }`：TTL 1 天。

## Admin

来源：`backend/src/modules/bots/schemas/*.schema.ts`

### `BotStatusEntity`

| 字段               | 类型             | 约束 / 默认值           | 说明                  |
| ------------------ | ---------------- | ----------------------- | --------------------- |
| `friendCode`       | `string`         | required, unique, index | bot 好友码            |
| `available`        | `boolean`        | required                | 是否可用              |
| `lastReportedAt`   | `Date`           | required                | 最近上报时间          |
| `friendCount`      | `number \| null` | default `null`          | 好友数                |
| `friendsUpdatedAt` | `Date \| null`   | default `null`          | 好友列表更新时间      |
| `friends`          | `BotFriendRow[]` | default `[]`            | bot 当前好友列表快照  |
| `remark`           | `string \| null` | default `null`          | 管理备注              |
| `cabinetUserId`    | `number \| null` | default `null`          | bot 对应的机台 userId |

索引：

- `friendCode`：唯一索引。

嵌套类型：

```ts
type BotFriendRow = {
  friendCode: string;
  userName: string | null;
  rating: number | null;
};
```

## Auto Update

来源：`backend/src/modules/auto-update/schemas/*.schema.ts`

### `AutoUpdateRunEntity`

| 字段              | 类型                       | 约束 / 默认值           | 说明                                     |
| ----------------- | -------------------------- | ----------------------- | ---------------------------------------- |
| `bucketKey`       | `string`                   | required, unique, index | cron bucket，格式类似 `YYYY-MM-DDTHH:MM` |
| `triggeredAt`     | `Date`                     | required                | 触发时间                                 |
| `ranOn`           | `string`                   | default `unknown`       | 赢得本轮 sweep 的实例                    |
| `status`          | `'running' \| 'completed'` | default `running`       | 执行状态                                 |
| `totalUsers`      | `number`                   | default `0`             | 本轮候选用户数                           |
| `triggered`       | `number`                   | default `0`             | 本轮 rival hash 变化并写入 sync 的数量   |
| `skippedNoChange` | `number`                   | default `0`             | rival/map 未变化跳过数                   |
| `failed`          | `number`                   | default `0`             | 失败数                                   |

索引：

- `bucketKey`：唯一索引。
- `{ triggeredAt: 1 }`：TTL 30 天。

### `AutoUpdateProbeStateEntity`

| 字段                            | 类型                        | 约束 / 默认值            | 说明                                 |
| ------------------------------- | --------------------------- | ------------------------ | ------------------------------------ |
| `friendCode`                    | `string`                    | required, unique, index  | 用户好友码                           |
| `cabinetUserId`                 | `number`                    | required, index          | 机台用户 ID                          |
| `enabled`                       | `boolean`                   | default `true`, index    | 是否仍参与自动更新                   |
| `tier`                          | `'hot' \| 'warm' \| 'cold'` | default `cold`, index    | 活跃度档位                           |
| `lastRivalHash`                 | `string \| null`            | default `null`           | 最近成功写入 sync 对应的 rival hash  |
| `lastRivalProbeAt`              | `Date \| null`              | default `null`           | 最近 RivalMusic probe 时间           |
| `nextRivalProbeAt`              | `Date \| null`              | default `null`, index    | 下一次 RivalMusic probe 时间         |
| `lastScoreChangedAt`            | `Date \| null`              | default `null`           | 最近成绩 hash 变化时间               |
| `mapFingerprint`                | `string \| null`            | default `null`           | 最近 Map fingerprint                 |
| `mapDistanceSum`                | `number \| null`            | default `null`           | 最近 Map distance 总和               |
| `lastMapProbeAt`                | `Date \| null`              | default `null`           | 最近 Map auxiliary 时间              |
| `lastMapDeltaAt`                | `Date \| null`              | default `null`           | 最近 Map 变化时间                    |
| `nextMapProbeAt`                | `Date \| null`              | default `null`, index    | 下一次 Map auxiliary 时间            |
| `lastRecentEventAt`             | `Date \| null`              | default `null`           | 最近 FC/FS enrichment 时间           |
| `nextRecentEventAt`             | `Date \| null`              | default `null`, index    | 下一次允许 recent event 时间         |
| `lastAutoUpdateActivityAt`      | `Date \| null`              | default `null`           | 最近自动更新活动信号时间             |
| `pendingFullUpdateAt`           | `Date \| null`              | default `null`, index    | 稳定后全量 update_score 预约时间     |
| `lastRecentEventFingerprint`    | `string \| null`            | default `null`           | 最近 recent event 轻量 fingerprint   |
| `pendingRecentEventReason`      | `string \| null`            | default `null`, index    | cooldown/retry 期间挂起的 FC/FS 原因 |
| `pendingRecentEventRequestedAt` | `Date \| null`              | default `null`           | 最近 pending FC/FS 触发时间          |
| `pendingRecentEventCount`       | `number`                    | default `0`              | pending FC/FS 合并触发次数           |
| `rivalErrorCount`               | `number`                    | default `0`              | Rival probe 连续错误数               |
| `mapErrorCount`                 | `number`                    | default `0`              | Map auxiliary 连续错误数             |
| `recentErrorCount`              | `number`                    | default `0`              | Recent event 连续错误数              |
| `backoffUntil`                  | `Date \| null`              | default `null`, index    | 主链路退避截止时间                   |
| `habitMultiplier`               | `number`                    | default `1`              | Phase 2 用户习惯倍率预留             |
| `loadMultiplier`                | `number`                    | default `1`              | 负载倍率预留                         |
| `schedulerVersion`              | `string`                    | default `rival-first-v1` | 调度策略版本                         |
| `createdAt` / `updatedAt`       | `Date`                      | timestamps               | 创建/更新时间                        |

索引：

- `friendCode`：唯一索引。
- `cabinetUserId`：单字段索引。
- `{ enabled: 1, nextRivalProbeAt: 1, tier: 1 }`，名称 `due_rival_probe`。
- `{ enabled: 1, nextMapProbeAt: 1, tier: 1 }`，名称 `due_map_probe`。
- `{ enabled: 1, pendingRecentEventReason: 1, nextRecentEventAt: 1 }`，名称 `due_pending_fcfs`。
- `{ enabled: 1, pendingFullUpdateAt: 1 }`，名称 `due_pending_full_update`。

### `AutoUpdateTaskEntity`

| 字段                      | 类型                                                          | 约束 / 默认值           | 说明                                                    |
| ------------------------- | ------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `id`                      | `string`                                                      | required, unique, index | task id                                                 |
| `type`                    | `rival_score_probe \| map_auxiliary_probe \| fcfs_enrichment` | required, index         | 任务类型                                                |
| `friendCode`              | `string`                                                      | required, index         | 用户好友码                                              |
| `cabinetUserId`           | `number`                                                      | required, index         | 机台用户 ID                                             |
| `status`                  | `queued \| processing \| completed \| failed \| canceled`     | required, index         | 状态；当前 Phase 1 主要使用 processing/completed/failed |
| `priority`                | `number`                                                      | default `0`             | 优先级记录                                              |
| `runAt`                   | `Date \| null`                                                | default `null`, index   | 预留执行时间                                            |
| `attempts`                | `number`                                                      | default `0`             | 尝试次数                                                |
| `lastError`               | `string \| null`                                              | default `null`          | 最近错误                                                |
| `metrics`                 | `Record<string, unknown> \| null`                             | `Mixed`, default `null` | 耗时、返回条数、命中数等轻量元信息                      |
| `createdAt` / `updatedAt` | `Date`                                                        | timestamps              | 创建/更新时间                                           |

索引：

- `id`：唯一索引。
- `type`、`friendCode`、`cabinetUserId`、`status`、`runAt`：单字段索引。
- `{ type: 1, status: 1, runAt: 1 }`，名称 `type_status_due`。
- `{ createdAt: 1 }`：TTL 3 天。

## SDGB Worker

来源：`backend/src/modules/sdgb-worker/*.schema.ts`

### `SdgbJobEntity`

| 字段           | 类型                              | 约束 / 默认值           | 说明                 |
| -------------- | --------------------------------- | ----------------------- | -------------------- |
| `id`           | `string`                          | required, unique, index | sdgb job id          |
| `jobType`      | `SdgbJobType`                     | required, index         | 机台协议任务类型     |
| `status`       | `SdgbJobStatus`                   | required, index         | job 状态             |
| `payload`      | `Record<string, unknown>`         | `Mixed`, required       | job 输入             |
| `result`       | `Record<string, unknown> \| null` | `Mixed`, default `null` | job 结果             |
| `error`        | `string \| null`                  | default `null`          | 错误信息             |
| `executing`    | `boolean`                         | default `false`         | worker 是否正在执行  |
| `claimedAt`    | `Date \| null`                    | default `null`          | 开始执行时间         |
| `requesterTag` | `string \| null`                  | default `null`, index   | 生产者自定义追踪 tag |
| `createdAt`    | `Date`                            | timestamps              | 创建时间             |
| `updatedAt`    | `Date`                            | timestamps              | 更新时间             |

枚举和 payload/result 约定：

```ts
type SdgbJobType = "scan_qr" | "get_rival_hash" | "get_user_map" | "add_rival";
type SdgbJobStatus = "queued" | "processing" | "completed" | "failed";

type SdgbJobPayload =
  | { qrCode: string; callerUid?: number }
  | { cabinetUserId: number; callerUid?: number }
  | { cabinetUserId: number }
  | { botCabinetUserId: number; targetCabinetUserId: number };

type SdgbJobResult =
  | { cabinetUserId: number; music: unknown[]; hash: string }
  | { hash: string; music: unknown[] }
  | { maps: unknown[] }
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

| Document 类型            | Entity                 |
| ------------------------ | ---------------------- |
| `UserDocument`           | `UserEntity`           |
| `SyncDocument`           | `SyncEntity`           |
| `MusicDocument`          | `MusicEntity`          |
| `JobDocument`            | `JobEntity`            |
| `QrLoginAttemptDocument` | `QrLoginAttemptEntity` |
| `BotStatusDocument`      | `BotStatusEntity`      |
| `AutoUpdateRunDocument`  | `AutoUpdateRunEntity`  |
| `SdgbJobDocument`        | `SdgbJobEntity`        |
