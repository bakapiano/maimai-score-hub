# 自动更新链路设计

目标链路拆成三段：Rival Score Probe、Map Auxiliary Probe、FC/FS Enrichment。三段分别记录任务和失败状态；Phase 1 backend 通过 batch/concurrency/cooldown/backoff 控制生产节奏，sdgb-worker 通过 BullMQ 并发和 token bucket 控制实际 cabinet API QPS。

## 1. Rival Score Probe

输入：开启自动更新且绑定 cabinet userId 的用户。

执行：

1. 根据用户 tier 查询到期的 rival probe 状态。
2. 调用 `GetUserRivalMusicApi`。
3. 计算 rival score hash。hash / diff 只用于判断是否发生变化和是否触发后续任务，不用于生成“增量写入列表”。
4. 如果 hash 变化：
   - 将本次 `GetUserRivalMusicApi` 返回的完整 achievement / dxScore list 映射成本地成绩。
   - 不需要和上一次 rival 结果做 diff；直接把本次 list 与用户当前成绩合并。
   - 与用户当前成绩合并，保留更高 achievement、dxScore、FC、FS。
   - 更新 `lastRivalHash`、`lastScoreChangedAt`。
   - 将用户升为 hot。
   - 变化谱面 CID 进入下一个半小时 FC/FS enrichment 窗口。
5. 如果 hash 未变化：
   - 更新 `lastRivalProbeAt`。
   - 不写 sync。
   - 如果用户处于 hot 且长时间没有 map auxiliary，可以 enqueue map auxiliary 用于 score-silent 探活。

输出：

- 最新 achievement / dxScore / rating。
- `lastRivalHash`。
- 用户 tier。
- 可选 FC/FS 补全任务。

## 2. Map Auxiliary Probe

输入：需要识别 score-silent 活跃的用户。

执行：

1. 调用 `GetUserMapApi`。
2. 计算 map fingerprint：
   - 取 `userMapList` 中每条记录的 `mapId` 和 `distance`。
   - 丢弃没有合法 `mapId` 或 `distance` 的记录。
   - 按 `mapId` 升序排序。
   - 拼接为稳定字符串：`<mapId>:<distance>|<mapId>:<distance>|...`。
   - 对该字符串计算 SHA-256，得到 `mapFingerprint`。
   - 同时计算 `mapDistanceSum = sum(distance)`，用于排查和粗略趋势展示。
   - 2026-06-27 对 10 个线上自动更新用户抽样验证：`GetUserMapApi` 返回字段为 `mapId/distance/isLock/isClear/isComplete/unlockFlag`，每个用户连续读取两次后 fingerprint 与 `mapDistanceSum` 均稳定；样本 row count 为 54-137，无非法 `mapId/distance`。
3. 如果 fingerprint 变化：
   - 更新 `lastMapDeltaAt`。
   - 将用户升为 hot 或延长 hot session。
   - score/dxScore 变化会在半小时窗口中生成 targeted FC/FS pending。
   - 如果距离上次 rival probe 已超过 tier 间隔，enqueue rival score probe。
4. 如果 fingerprint 未变化：
   - 更新 `lastMapProbeAt`。
   - 根据 tier 计算下一次 auxiliary probe。

输出：

- score-silent 活跃信号。
- 下一次 map auxiliary 时间。
- 可选 rival score probe / FCFS enrichment 任务。

## 3. FC/FS Enrichment

输入：rival score probe 发现成绩变化，或 map auxiliary 发现 score-silent 活跃后的用户。

FC/FS Enrichment 是 **change-driven**，不是 **tier-driven**：

- 不对所有 hot 用户定期执行。
- hot 只会提高 rival probe / map auxiliary 的探测频率，从而提高触发 FC/FS enrichment 的机会。
- 当前 Phase 1 真正 enqueue 只由 rival hash 变化、map fingerprint 变化触发；手动/管理员强制刷新入口尚未实现。

执行：

1. 每半小时聚合该窗口 `score_changes` 中 `score/dxScore` 变化的谱面 CID。
2. 单用户 cooldown 或 producer 配额占用期间，把 CID 合并进 `pendingFcfsMusicIds`。
3. 到期后创建 background `update_score(musicIds, fcfsOnly=true)`。
4. Worker 根据 CID 元数据选择最小扫描量的具体 genre/level 页面组合。
5. Backend 按 CID 直接映射，并通过 rank-only CAS 合并 FC/FS。
6. task 跟踪 DXNet job 终态；失败时把原 CID 放回 pending 并按 backoff 重试。

输出：

- 最近 FC/FS 增量。
- `lastFcfsUpdateAt` / `nextFcfsUpdateAt`。
- pending FC/FS enrichment 状态（cooldown 未到或执行失败时）。
- 本窗口聚合的谱面 CID 数与页面规划结果。

## 解耦要求

- Rival Score Probe 失败不写 sync。
- Map Auxiliary Probe 失败不影响已有成绩。
- FC/FS Enrichment 失败不影响已经写入的 achievement / dxScore。
- 三类任务都需要单独记录错误和 backoff。
