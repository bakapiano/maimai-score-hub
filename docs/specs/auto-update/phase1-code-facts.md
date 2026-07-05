# Phase 1 代码事实

本文档记录当前已实现的 Rival-first Phase 1 代码事实。

## 已实现范围

- 新自动更新 scheduler 是唯一的自动更新任务生产者。
- 主链路直接调用 sdgb `get_rival_hash`，也就是 `GetUserRivalMusicApi` 的后端封装。
- hash 变化时，不再创建 DXNet `update_score` job；后端直接把本次 rival music list 与用户当前 sync 合并。
- hash / diff 只用于探测是否变化；写入时始终使用本次返回 list 与当前成绩合并。
- 新增持久状态集合 `auto_update_probe_states`。
- 新增短期任务日志集合 `auto_update_tasks`，TTL 为 3 天。
- `SyncService.createFromRivalMusic()` 支持 cabinet/rival music 直接映射为本地成绩并合并写入。
- Map auxiliary probe 已接入调度：调用 sdgb `get_user_map`，计算 `mapFingerprint` / `mapDistanceSum`，发现变化时延长 hot session，并按条件触发 FC/FS enrichment。
- sdgb-worker 已支持 `get_user_map` jobType，对应 `GetUserMapApi`。
- sdgb-worker 已改为 BullMQ consumer，消费 `sdgb-worker-jobs`，不再调用 `/workers/sdgb/jobs/next` 拉取。
- sdgb-worker 已实现 global + per-API token bucket，并支持按 job type 并发上限。
- FC/FS enrichment 已接入自动调度：由 rival hash 变化或 map delta 请求触发；如果 recent event cooldown 未到，会在 `auto_update_probe_states` 记录 pending 并到期补跑；实际执行时先 `addRival`，再创建 DXNet `get_user_recent_event` job。
- Worker `get_user_recent_event` handler 已实现，会请求好友详情 recent event 页面并把解析出的 events PATCH 回后端。
- `JobService.patch()` 会在 `get_user_recent_event` 完成后调用 `SyncService.mergeRecentEvents()`，把本次 FC/FS list 直接与用户当前成绩按 rank 合并。
- FC/FS enrichment 不使用 `recentEventSince` 过滤；如果 recent event 的 `songName + difficulty` 在当前成绩里无法唯一定位 score，会跳过该条 event，不触发 fallback。
- recent event fingerprint 变化会记录 activity signal，并把稳定后全量 `update_score` 预约到 activity 后 45 分钟。
- `update_score` 支持 `diffsToScrape` 字段；稳定后全量更新传 `diffsToScrape=null`，走 worker 默认全难度。
- music 表在 `SyncService` 内做 5 分钟缓存，避免每个用户 probe 都全表查询。
- 初次迁移到新状态表时，会按 friendCode 做 deterministic offset，把首次 probe 分散到 cold interval 内，避免 cutover 后所有用户同时到期。

## 当前未实现范围

- `auto_update_play_habits` 用户习惯画像尚未实现；Phase 1 只预留 `habitMultiplier` / `loadMultiplier`。
- Admin dashboard 的 auto-update metrics 仍需后续改为读取 `auto_update_probe_states` / `auto_update_tasks`。

## 关键代码入口

| 文件                                                                        | 作用                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `backend/src/modules/auto-update/services/auto-update-scheduler.service.ts` | Rival-first scheduler，按 due state 执行 rival score probe  |
| `backend/src/modules/auto-update/schemas/auto-update-probe-state.schema.ts` | 自动更新用户状态                                            |
| `backend/src/modules/auto-update/schemas/auto-update-task.schema.ts`        | 自动更新短期任务日志                                        |
| `backend/src/modules/sdgb-worker/**`                                        | `get_user_map` / `get_rival_hash` / `add_rival` 后端 job    |
| `backend/src/modules/sync/services/sync.service.ts`                         | 直接合并 rival music list 和 recent event FC/FS list        |
| `backend/src/modules/job/services/job.service.ts`                           | recent event job 完成后触发 FC/FS 合并                      |
| `worker/src/worker/jobs/handlers/get-user-recent-event/**`                  | DXNet recent event 抓取                                     |
| `sdgb-worker/src/**`                                                        | BullMQ consumer、token bucket、sdgb `get_user_map` 执行逻辑 |
| `backend/src/modules/auto-update/auto-update.module.ts`                     | 注册新状态 / 任务 schema                                    |

## Phase 1 调度参数

| 配置                                       |          默认 |
| ------------------------------------------ | ------------: |
| `AUTO_UPDATE_CRON`                         | `*/1 * * * *` |
| `AUTO_UPDATE_HOT_INTERVAL_MS`              |       10 分钟 |
| `AUTO_UPDATE_WARM_INTERVAL_MS`             |       30 分钟 |
| `AUTO_UPDATE_COLD_INTERVAL_MS`             |        1 小时 |
| `AUTO_UPDATE_HOT_SESSION_MS`               |       90 分钟 |
| `AUTO_UPDATE_WARM_MAX_IDLE_MS`             |          7 天 |
| `AUTO_UPDATE_RIVAL_BATCH_LIMIT`            |           480 |
| `AUTO_UPDATE_RIVAL_CONCURRENCY`            |             4 |
| `AUTO_UPDATE_RIVAL_TIMEOUT_MS`             |        120 秒 |
| `AUTO_UPDATE_MAP_BATCH_LIMIT`              |           120 |
| `AUTO_UPDATE_MAP_CONCURRENCY`              |             2 |
| `AUTO_UPDATE_MAP_TIMEOUT_MS`               |         60 秒 |
| `AUTO_UPDATE_MAP_HOT_INTERVAL_MS`          |       30 分钟 |
| `AUTO_UPDATE_MAP_WARM_INTERVAL_MS`         |        1 小时 |
| `AUTO_UPDATE_MAP_COLD_INTERVAL_MS`         |        1 小时 |
| `AUTO_UPDATE_RECENT_EVENT_COOLDOWN_MS`     |       30 分钟 |
| `AUTO_UPDATE_RECENT_EVENT_DELAY_MS`        |        3 分钟 |
| `AUTO_UPDATE_SETTLED_FULL_UPDATE_DELAY_MS` |       45 分钟 |
| `AUTO_UPDATE_SETTLED_FULL_UPDATE_RETRY_MS` |       10 分钟 |

sdgb-worker:

| 配置                         | 默认 |
| ---------------------------- | ---: |
| `SDGB_WORKER_CONCURRENCY`    |   16 |
| `SDGB_GLOBAL_QPS`            |   12 |
| `SDGB_GLOBAL_BURST`          |   15 |
| `SDGB_RIVAL_QPS`             |    8 |
| `SDGB_RIVAL_BURST`           |   12 |
| `SDGB_RIVAL_CONCURRENCY`     |    8 |
| `SDGB_MAP_QPS`               |    3 |
| `SDGB_MAP_BURST`             |    6 |
| `SDGB_MAP_CONCURRENCY`       |    4 |
| `SDGB_ADD_RIVAL_QPS`         |  0.5 |
| `SDGB_ADD_RIVAL_BURST`       |    1 |
| `SDGB_ADD_RIVAL_CONCURRENCY` |    1 |
| `SDGB_SCAN_QR_QPS`           |    1 |
| `SDGB_SCAN_QR_BURST`         |    2 |
| `SDGB_SCAN_QR_CONCURRENCY`   |    1 |

## 状态流转

```text
new enabled user
  -> auto_update_probe_states upsert
  -> tier=cold
  -> nextRivalProbeAt = now + deterministicOffset(friendCode, 1h)

due rival probe
  -> sdgb.getRivalHash({ cabinetUserId })
  -> hash changed:
       SyncService.createFromRivalMusic()
       tier=hot
       nextRivalProbeAt=now+10m
  -> hash unchanged:
       decay tier by lastScoreChangedAt / lastMapDeltaAt
       nextRivalProbeAt=now+interval(tier)
  -> failed:
       rivalErrorCount += 1
       backoffUntil = now + exponential backoff

due map auxiliary probe
  -> sdgb.getUserMap({ cabinetUserId })
  -> fingerprint changed:
       lastMapDeltaAt=now
       tier=hot
       request FC/FS enrichment; if cooldown not due, record pending
       nextRivalProbeAt=now if rival interval already elapsed
  -> fingerprint unchanged:
       decay tier by lastScoreChangedAt / lastMapDeltaAt
       nextMapProbeAt=now+mapInterval(tier)

FC/FS enrichment
  -> if cooldown not due: record pendingRecentEventReason / pendingRecentEventRequestedAt
  -> when pending is due: execute once and clear pending on success
  -> sdgb.addRival(botCabinetUserId, cabinetUserId)
  -> create DXNet get_user_recent_event job
  -> worker fetches recent events
  -> JobService merges returned FC/FS list into current sync
  -> if recent event fingerprint changed:
       record activity signal and delay pending full update_score by 45min

Settled full update
  -> any rival/map/recent activity signal sets pendingFullUpdateAt=now+45min
  -> if more activity appears before due, delay pendingFullUpdateAt again
  -> when due, create update_score with diffsToScrape=null
  -> if an active update_score already exists, clear pending without creating a duplicate
```

## 写入语义

Rival score probe:

- `GetUserRivalMusicApi` 返回完整 achievement / dxScore list。
- list 直接与用户当前 sync 合并。
- 不保存并 diff 上一次 rival 结果。
- `lastRivalHash` 只在成功合并写入后推进。

合并规则：

```text
achievement / dxScore: 取更高数值
FC: null < fc < fcp < ap < app
FS: null < fs < fsp < fdx < fdxp
```
