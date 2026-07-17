# Queue、Priority 与 Concurrency

## 1. 为什么不能只提高 priority

BullMQ priority 只决定 waiting job 的取出顺序。已经进入 active 的长耗时 job 不会被高
优先级 job 抢占。若一个 queue 的全部 concurrency 都被后台 `update_score` 占满，后来的
登录、好友申请即使 priority 更高也必须等待。

因此需要两层控制：

1. **lane queue**：为不同延迟目标保留独立 slot。
2. **job-type semaphore**：限制同类任务在单个 Bot 上的精确并发。

priority 只在同一 lane 内排序。

## 2. 推荐 DXNet lane

| lane | 目标 | 典型来源 | 初始每 worker concurrency |
| --- | --- | --- | ---: |
| `interactive` | 登录、好友关系、QR 等短交互 | 用户登录、QR login、好友申请 | 2 |
| `user_sync` | 用户主动发起的长查分 | 手动 `update_score` | 2 |
| `background` | 可排队、可退避的后台任务 | 自动 recent event、自动 full update、维护刷新 | 3 |

默认总 active 上限为每 Bot 7 个 job，而不是用一个全局 16/256 concurrency 让后台任务耗尽
所有 slot。具体值必须通过线上 p95、Bot 上游错误率和 lock renewal 指标逐步调整。

`background=3` 的目标不是允许 3 个同类任务无差别并发，而是为每个 worker 保留：

- 最多 2 个 `get_user_recent_event`。
- 最多 1 个 background `update_score`。
- maintenance 与上述任务共享剩余 background slot，不能突破 lane 总上限。

建议配置：

```text
DXNET_LANE_INTERACTIVE_CONCURRENCY=2
DXNET_LANE_USER_SYNC_CONCURRENCY=2
DXNET_LANE_BACKGROUND_CONCURRENCY=3
DXNET_JOB_GET_USER_RECENT_EVENT_CONCURRENCY=2
DXNET_JOB_BACKGROUND_UPDATE_SCORE_CONCURRENCY=1
DXNET_JOB_MAINTENANCE_CONCURRENCY=1
```

### 2.1 线上容量基线（2026-07-17 回看）

关闭自动 recent-event producer 后的当前队列很空，因此不能用当前瞬时 depth 判断恢复后的
容量。本设计回看了关闭前 ClickHouse `job_timeline_events`：

| 指标 | 观测值 |
| --- | ---: |
| 2026-07-04 recent-event created | 2,048 |
| 2026-07-05 recent-event created | 2,596 |
| 全局 5 分钟创建峰值 | 151（约 30/min） |
| 单 Bot 5 分钟创建峰值 | 104-110（约 21-22/min） |
| 单 Bot 5 分钟创建 p95 | 48-75 |
| 2026-07-04 单 Bot runtime 平均 | 19-25s |
| 2026-07-04 单 Bot runtime p95 | 75-125s |
| 2026-07-04 全局 queue wait p95 | 747.5s |

这说明 `background=1` 会在历史批量生产模式下形成分钟级积压。每 worker 给 recent-event 2 个
slot，三台 worker 合计 6 个 slot；按历史 13-25s 的常见 runtime，理论吞吐约 14-28/min，
能覆盖日均并显著缩短 drain 时间，但仍可能在 30/min 峰值时短暂排队。

因此 concurrency 调整必须和 producer smoothing 一起上线：scheduler 不应在短时间把数百个
due user 同时 enqueue；应按全局/per-Bot 速率均匀释放。不要单纯把 recent-event 恢复到历史
十几个甚至几十个 active/Bot，否则上游变慢后会反向拉长 runtime、lock 持有时间和失败恢复。

同一回看窗口的当前非自动任务数据：manual `update_score` queue wait p95 约 4.13s，
send/accept/get-full-friend-list p95 低于 0.2s。因此没有数据支持把 `interactive` 或
`user_sync` 初始值提高到 2 以上。

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

迁移期可保留旧 `dxnet-worker-jobs-<botFriendCode>`，只把新 cabinet-assisted claim job
放进 shared queues。等 claim API 和 lane consumer 稳定后，再迁 pinned lane queues。

每个 worker：

- 消费全部 shared lane queues，claim 时绑定自己的 Bot。
- 只消费自己的 pinned queues。
- Bot expired 时暂停该进程的所有 DXNet queue consumer。
- 所有 consumer 共用同一个 `MaimaiClient` request runtime、cookie 和 per-type semaphore。

## 4. Lane 映射不能只看 jobType

同一个 `jobType` 可能来自用户或后台，延迟目标不同，因此 job 需要显式 `source`：

```ts
type DxnetJobSource =
  | "user_interaction"
  | "user_sync"
  | "qr_login"
  | "auto_update"
  | "maintenance";
```

推荐映射：

| source / jobType | lane | assignment |
| --- | --- | --- |
| `user_interaction/send_friend_request` | interactive | claim 或 pinned |
| `user_interaction/accept_friend_request` | interactive | pinned |
| `qr_login/get_full_friend_list` | interactive | claim + cabinet prerequisite |
| `user_sync/update_score` | user_sync | existing friend 时 pinned，否则 claim |
| `auto_update/get_user_recent_event` | background | claim + cabinet prerequisite |
| `auto_update/update_score` | background | claim 或 pinned |
| `maintenance/get_full_friend_list` | background | pinned |

`lane` 在创建时物化到 Mongo，不能在 worker 端按 context 临时猜测。

## 5. Priority 模型

建议业务 priority 使用“数值越大越重要”，enqueue BullMQ 时统一转换；不要在不同模块直接
混用 BullMQ 的“数值越小越优先”语义。

推荐业务 rank：

| rank | 含义 | 示例 |
| ---: | --- | --- |
| 400 | immediate | OAuth cookie exchange、正在等待的 QR login continuation |
| 300 | interactive | send/accept friend request、QR snapshot |
| 200 | user sync | 用户手动 update_score |
| 100 | background | auto recent event、auto update_score |
| 50 | maintenance | periodic snapshot、cleanup |

转换函数集中在 shared/backend：

```ts
function toBullmqPriority(rank: number): number {
  return Math.max(1, 1000 - rank);
}
```

不同 lane 本身已经隔离，因此 priority 主要解决同 lane 内的细分顺序、deadline 和 retry。

## 6. Per-type concurrency

BullMQ OSS 的 `Worker.concurrency` 是 queue consumer 级别，不是 name/jobType 级别。要实现
“每种 job 不同 concurrency”，有两个选择：

- 每种 jobType 一个 queue：控制直接，但 queue/consumer 数量快速膨胀，且同 source 的全局
  排序和迁移复杂。
- lane queue + worker 本地 semaphore：queue 数量稳定，type cap 清晰。

本设计推荐第二种。每个 worker process 创建共享 semaphore registry：

```ts
const JOB_TYPE_LIMITS = {
  send_friend_request: 2,
  accept_friend_request: 2,
  update_score_user: 2,
  update_score_background: 1,
  get_user_recent_event: 2,
  get_full_friend_list_interactive: 1,
  get_full_friend_list_maintenance: 1,
};
```

建议初始值：

| 执行类别 | per Bot cap | 说明 |
| --- | ---: | --- |
| send/accept friendship | 2 | 等待 stage 必须 moveToDelayed，不长期占 slot |
| QR full friend list | 1 | 多页请求，避免同 Bot 并发扫描 |
| 手动 update_score | 2 | 用户可见，但单 job 本身已有 Friend VS 内部并发 |
| 后台 update_score | 1 | 不能挤占手动查分 |
| get_user_recent_event | 2 | 历史 producer 峰值高；每 worker 保留 2 个执行槽，仍允许排队 |
| maintenance snapshot | 1 | 最低优先级 |

semaphore 等待不应让 BullMQ job 长时间保持 active。worker 若拿到 job 后发现 type cap 已满，
应立即 `moveToDelayed(now + shortJitter)`，释放 lock/active slot，而不是在进程内 await 数分钟。

## 7. addRival 的 sdgb 调度

worker-triggered prepare 最终仍会创建 sdgb `add_rival`。为避免后台 addRival 阻塞 QR/手动
交互，sdgb job 必须继承 parent job 的 traffic class 和 priority。

推荐队列：

```text
sdgb-worker-interactive-jobs       # scan_qr、QR/manual add_rival
sdgb-worker-background-mutation-jobs # auto-update add_rival
sdgb-worker-jobs                   # rival/map probes
```

如果第一阶段不新增 background mutation queue，至少要在现有 interactive queue 中设置
BullMQ priority，并继续使用 `add_rival` 全局 token bucket 和 concurrency=1。拆 queue 后所有
addRival queue 仍必须共享同一个 per-API limiter，不能因为多 queue 把实际 QPS 翻倍。

## 8. Deadline 与饥饿保护

- interactive job 带较短 deadline；超时后返回明确错误，不无限重试。
- background job 使用指数退避和随机 jitter。
- background lane 可设置最大 queue age，超过后 coalesce 或 cancel，避免执行已经失去价值的
  自动更新。
- shared queue claim 失败时短 delay，不能 busy loop。
- 每个 lane 记录 oldest waiting age；不能只看总 depth。
