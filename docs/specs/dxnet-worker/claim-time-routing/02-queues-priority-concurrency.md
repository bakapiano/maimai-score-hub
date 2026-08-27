# Queue、Priority 与 Concurrency

## 1. 为什么不能只提高 priority

BullMQ priority 只决定 waiting job 的取出顺序。已经进入 active 的长耗时 job 不会被高
优先级 job 抢占。若一个 queue 的全部 concurrency 都被后台 `update_score` 占满，后来的
登录、好友申请即使 priority 更高也必须等待。

因此使用独立 lane queue 为不同延迟目标保留 slot。concurrency 只在 BullMQ queue/consumer
这一层定义，不再增加进程级 AdmissionController 或 per-type semaphore。priority 只在同一个
queue 内排序；跨 queue 的 DXNet request 仍由共享 request scheduler 按 priority 排序。

## 2. DXNet lane

| lane          | 目标                        | 典型来源                                   | 每个 queue 的 concurrency |
| ------------- | --------------------------- | ------------------------------------------ | ------------------------: |
| `interactive` | 登录、好友关系、QR 等短交互 | 用户登录、QR login、好友申请               |                         8 |
| `user_sync`   | 用户主动发起的长查分        | 手动 `update_score`                        |                        16 |
| `background`  | 可排队、可退避的后台任务    | targeted FC/FS、自动 full update、维护刷新 |                         4 |

`8/16/4` 是 **每个 BullMQ queue consumer 各自的 concurrency**。同一 lane 的 shared 与
pinned consumer 不合并计数；二者同时满载时可以分别执行到该值。一个 v2 Bot 进程六个 queue
的理论 active 上限因此是 `2 × (8 + 16 + 4) = 56`。好友容量仍由 backend 的 per-Bot assignment
mutex 和 hard limit 80 防守，不在 worker 内再维护第二套预算。

线上继续保持一个 Bot、一个 Node 进程、一套 CookieJar/MaimaiClient。目标态只是在同一进程
内创建多个 BullMQ `Worker` 对象，不增加 Bot 进程或容器：

```text
one Bot process
  shared-interactive consumer concurrency=8
  pinned-<bot>-interactive consumer concurrency=8
  shared-user-sync consumer concurrency=16
  pinned-<bot>-user-sync consumer concurrency=16
  shared-background consumer concurrency=4
  pinned-<bot>-background consumer concurrency=4
```

不做 shared/pinned 借用、动态拆分或进程级二次排队。某个 route 空闲不会把 concurrency 转给
另一个 queue；某个 job type 也没有额外 cap。实际 DXNet 请求仍统一经过每 Bot 每 2.5 秒一次的
priority-aware request throttle，因此 queue concurrency 增加的是并发 job 数，不会直接放大请求
启动速率。

固定配置：

```text
DXNET_LANE_INTERACTIVE_CONCURRENCY=8
DXNET_LANE_USER_SYNC_CONCURRENCY=16
DXNET_LANE_BACKGROUND_CONCURRENCY=4
```

### 2.1 线上容量基线（2026-07-17 回看）

关闭自动 recent-event producer 后的当前队列很空，因此不能用当前瞬时 depth 判断恢复后的
容量。本设计回看了关闭前 ClickHouse `job_timeline_events`：

| 指标                            |                  观测值 |
| ------------------------------- | ----------------------: |
| 2026-07-04 recent-event created |                   2,048 |
| 2026-07-05 recent-event created |                   2,596 |
| 全局 5 分钟创建峰值             |        151（约 30/min） |
| 单 Bot 5 分钟创建峰值           | 104-110（约 21-22/min） |
| 单 Bot 5 分钟创建 p95           |                   48-75 |
| 2026-07-04 单 Bot runtime 平均  |                  19-25s |
| 2026-07-04 单 Bot runtime p95   |                 75-125s |
| 2026-07-04 全局 queue wait p95  |                  747.5s |

这说明 background queue 不能把全部任务压成单路串行。shared/pinned background consumer
各自 concurrency=4，但最终请求吞吐仍由每 Bot request throttle 限制；因此 concurrency 调整
主要缩短 BullMQ queue wait，不应被解释成 16 倍上游 QPS。

因此 concurrency 调整必须和 producer smoothing 一起上线：scheduler 不应在短时间把数百个
due user 同时 enqueue；应按全局/per-Bot 速率均匀释放。不要单纯把 recent-event 恢复到历史
十几个甚至几十个 active/Bot，否则上游变慢后会反向拉长 runtime、lock 持有时间和失败恢复。

### 2.2 用户流量基线与低等待目标

最近 7 天 manual `update_score` 的线上分布：

| 指标                    | Bot 336 | Bot 413 | Bot 848 |
| ----------------------- | ------: | ------: | ------: |
| 5 分钟 created p95      |       6 |       7 |       7 |
| 5 分钟 created max      |      14 |      18 |      20 |
| 同时 active p95         |       9 |      13 |      13 |
| 同时 active p99         |      14 |      16 |      16 |
| 最近 24h queue wait p95 |   4.14s |   4.13s |   4.11s |

全局 5 分钟创建峰值为 37 个。固定 `user_sync=16` 对齐历史 active p99，目标是让大部分
手动同步无需等待 background job 或同 lane slot。interactive 当前 queue wait p95 低于
0.2s，但独立给 8 个 slot，防止恢复 background 后回归。

目标 SLO 按 enqueue 到 BullMQ processor active、准备首次 PATCH 的 queue wait 计算：

```text
interactive queue wait: p95 < 0.5s, p99 < 1s
user_sync queue wait:   p95 < 1s,   p99 < 5s
background queue wait:  无即时 SLO，按 oldest waiting age 告警
```

当前每个 Bot 的 DXNet request throttle 仍是每 2.5 秒启动一个请求；提高 job concurrency 不会
增加这个硬吞吐，只会让更多用户 job 更早进入 processing 并在 request scheduler 中排队。因此
还必须保留请求级 priority：interactive 和 user_sync 请求始终先于 background。若要降低完成
时间而不只是 queue wait，需要增加 Bot 数量或在验证
上游承载后调整 request rate，不能只继续放大 active job 数。

## 3. Queue 命名

shared claim queue：

```text
dxnet-shared-interactive-jobs
dxnet-shared-user-sync-jobs
dxnet-shared-background-jobs
```

pinned queue：

```text
dxnet-worker-<botFriendCode>-interactive-jobs
dxnet-worker-<botFriendCode>-user-sync-jobs
dxnet-worker-<botFriendCode>-background-jobs
```

旧 `dxnet-worker-jobs-<botFriendCode>` 不再创建 consumer。停机切换时 pre-v2 非终态 job 统一
canceled；所有新 job 都是 routing-v2：claim 投 shared lane，pinned 投 lane-aware per-Bot queue。

每个 worker：

- 消费全部 shared lane queues；BullMQ 将 job 置为 active 后，通过第一次 worker PATCH 绑定
  自己的 Bot。
- 只消费自己的 pinned queues。
- Bot expired 时暂停该进程的所有 DXNet queue consumer。
- 所有 consumer 共用同一个 `MaimaiClient` request runtime 和 cookie，但 concurrency 彼此独立。

## 4. Lane 映射不能只看 jobType

同一个 `jobType` 可能来自用户或后台，延迟目标不同，因此 job 需要显式 `source`：

```ts
type DxnetJobSource =
  | "user_interaction"
  | "user_sync"
  | "qr_login"
  | "cabinet_binding"
  | "auto_update"
  | "maintenance";
```

固定映射：

| source / jobType                             | lane        | priority | assignment                                  |
| -------------------------------------------- | ----------- | -------: | ------------------------------------------- |
| `user_interaction/send_friend_request`       | interactive |        3 | pinned                                      |
| `user_interaction/accept_friend_request`     | interactive |        3 | pinned                                      |
| `qr_login/get_full_friend_list`              | interactive |        4 | claim + cabinet prerequisite                |
| `cabinet_binding/get_full_friend_list`       | interactive |        4 | profile fallback only；claim + prerequisite |
| `user_sync/update_score`                     | user_sync   |        2 | existing friend 时 pinned，否则 claim       |
| `auto_update/update_score`（targeted FC/FS） | background  |        1 | claim + cabinet prerequisite                |
| `auto_update/update_score`                   | background  |        1 | existing friend 时 pinned，否则 claim       |
| `maintenance/get_full_friend_list`           | background  |        0 | pinned                                      |

`lane` 在创建时物化到 Mongo，不能在 worker 端按 context 临时猜测。

## 5. Priority 模型

系统只保留现有 `job.priority` 一个业务优先级字段，不再定义第二套字段或 50-400 标度。
`job.priority` 范围固定为 0-4，数值越大越优先：

| `job.priority` | 含义        | 示例                                                             |
| -------------: | ----------- | ---------------------------------------------------------------- |
|              4 | immediate   | `qr_login_resolution`；OAuth request 也使用同一 request priority |
|              3 | interactive | send/accept friend request                                       |
|              2 | user_sync   | 用户手动 update_score                                            |
|              1 | background  | targeted FC/FS、auto update_score                                |
|              0 | maintenance | periodic snapshot                                                |

这些值只在 `shared` 定义一次：

```ts
export const DXNET_PRIORITY = {
  maintenance: 0,
  background: 1,
  userSync: 2,
  interactive: 3,
  immediate: 4,
} as const;
```

backend 根据已经确定的 `source`、`lane` 和 purpose 生成 priority；public create API 不接收
priority，内部 producer 也不应散落任意数字 override。同一个数值贯穿三层：

这里仅指 DXNet `jobs.priority`。auto-update probe scheduler 现有的 tier priority 30/10/0 是其
内部 due-task 排序字段，不写入 DXNet job，也不参与本映射。

- Mongo `jobs.priority`：业务 source of truth。
- Maimai request scheduler：priority 大者先，同值 FIFO。
- BullMQ：enqueue 时转换为正整数，数值小者先。

BullMQ 把 0/未设置视为最高优先级，不能把业务 maintenance=0 原样传入或省略。v2 queue 的
转换函数集中在 shared/backend：

```ts
function toBullmqPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new Error("DXNet priority must be an integer from 0 to 4");
  }
  return 5 - priority;
}
```

对应关系固定为 `4→1、3→2、2→3、1→4、0→5`，所有 BullMQ job 都显式设置非零
priority。同 priority 继续 FIFO。

BullMQ priority 只排序同一 queue 的 waiting job；shared 与 pinned 之间不做统一 job-level
排序。真正跨 queue 竞争的是每 Bot 共用的 Maimai request scheduler，它按 4→0 严格选择下一次
请求，但不抢占已经发出的请求。

本设计不做 priority aging 或配额借用。持续有用户请求时 background 可以饥饿；这是有意的
用户保护策略。background 通过 producer smoothing、coalesce、最大 queue age 取消和 oldest-age
告警保证 backlog 不无限失控，而不是提升 priority 反向影响用户流量。

唯一的控制面继承规则是：claim job 因 snapshot 超过 5 分钟或 friendCount 达到 50 而触发
on-demand full-friend refresh/CleanupService 时，其中每个 DXNet request 继承该 job.priority；
否则严格低优先级 maintenance 可能被持续用户流量饿死，反过来阻塞用户 claim。周期性、非
按需 refresh/cleanup 仍为 maintenance=0。

## 6. 不做 per-type concurrency

BullMQ OSS 的 `Worker.concurrency` 是 queue consumer 级别。本设计只使用这一级控制，不再按
jobType 增加 semaphore，也不在 active 后等待本地 permit。processor active 后直接校验 route、
登记 execution 并执行；只有 snapshot/capacity、Bot eligibility 或基础设施错误才使用
`moveToDelayed` 退避。

因此同一 background queue 内的 recent-event、update_score 和 maintenance 共用 concurrency=4；
QR full-list、send/accept 也共用 interactive queue 的 concurrency=8。上游保护由现有 request
priority、2.5 秒 throttle、producer smoothing、deadline 和 backend 好友容量 mutex 负责。

## 7. addRival 的 sdgb 调度

worker-triggered prepare 最终仍会创建 sdgb `add_rival`。为避免后台 addRival 阻塞 QR/手动
交互，sdgb job 必须继承 parent `job.priority`。

沿用现有两条 sdgb lane，不新增 background mutation queue：

```text
sdgb-worker-interactive-jobs # scan_qr、get_music_score、所有 add_rival
sdgb-worker-jobs             # rival/map probes
```

backend enqueue `add_rival` 时把 parent priority 转成相同的 BullMQ 1-5 顺序：QR/manual
addRival 高于 auto-update addRival；同级保持 FIFO。现有 `add_rival` per-type concurrency=1
和 Stable 0.5 QPS 限速继续生效。priority 只能决定下一项，不能抢占已经发出的 mutation；为
这一点增加第三条 queue 也不会改善，反而需要修改独立 sdgb-worker 仓库的 routing、membership
和 limiter。

backend `sdgb_jobs` 增加 `priority: 0..4` 供审计和重建 BullMQ delivery；dispatcher 创建
scan_qr/get_music_score 时使用 4，add_rival 使用 parent `job.priority`。enqueue 到 Interactive
queue 时统一调用同一个 `5-priority` 转换；Probe lane 的现有调度不在本 proposal 中改动。

## 8. Deadline 与饥饿保护

- interactive job `deadlineAt=createdAt+5min`，与现有好友等待和 QR frontend polling 窗口一致。
- user_sync job `deadlineAt=createdAt+20min`，与当前 worker hard timeout 一致。
- background job `deadlineAt=createdAt+6h`，与 recent-event retry backoff cap 一致；超时后按用户
  coalesce key 取消旧 job，由 scheduler 重新评估是否仍需创建。
- backend/Redis 基础设施错误使用 5s 起步、2 倍指数退避、60s cap，并加入 0-5s jitter；不得
  超过 deadline。
- snapshot/capacity 拒绝固定使用 5-10s jitter；对应 Bot 同时暂停 shared consumers，不能
  busy loop 抢回同一 job。
- recent-event producer 使用 Redis leaky bucket，base 8 jobs/min、burst 2，并按健康 Bot 数动态降速。该值低于历史常见总吞吐
  14-28/min，又能覆盖约 1.8/min 的历史日均；后续只能根据 queue wait 和 oldest age
  调整，不能在单次 sweep 批量释放数百个任务。
- 每个 queue 记录 depth、active、oldest waiting 和 queue wait；不能只看六条 queue 的总和。

backend 在现有 maintenance Redis lock 下每分钟扫描 `deadlineAt <= now` 的非终态 v2 job：
interactive/user_sync 原子写 failed + `job_deadline_exceeded`，background 写 canceled 并按
coalesce key 通知 scheduler 重新评估；随后移除对应 waiting/delayed BullMQ delivery。active
processor 的每次 PATCH/prepare 也检查 deadline，避免 sweep 与迟到 worker 竞态。

## 9. Worker shutdown

当前生产 worker 没有完整的 SIGTERM drain coordinator；多 consumer 上线前必须补齐：

1. 收到 SIGTERM 后立即暂停该 Bot 的全部 shared/pinned consumers，不再 fetch 新 job。
2. 尚未完成首次 execution PATCH 的 active processor 立即 abort/requeue，不写 Mongo。
3. background execution 立即 abort/requeue；interactive 和 user_sync 最多再 drain 60 秒。
4. 60 秒后仍未结束的 handler 通过同一 AbortSignal 停止请求并 requeue；旧 generation 不得再
   PATCH。
5. 等待外部调用日志 flush，并 await 所有 BullMQ Worker close 后进程才退出。
6. `worker/docker-compose.yml` 设置 `stop_grace_period: 90s`，给 coordinator 留出 60 秒 drain
   和 30 秒关闭余量。

update_score/recent-event 是只读抓取，可安全重投；send/accept handler 必须继续保持“先验证当前
关系、再执行 mutation”的幂等顺序。addRival 由 sdgb job 独立持久化，DXNet worker shutdown
不得自行重发。
