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
   - enqueue `fcfs_enrichment` 候选任务。
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
   - 如果 recent event cooldown 已过，enqueue `fcfs_enrichment`。
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

1. 检查单用户 cooldown，例如 30 分钟内最多一次。
2. 选择可用 Bot。
3. 通过 sdgb `addRival` 确保 Bot 与目标用户有 rival/好友关系；如果目标用户后续被 DXNet cleanup 从 Bot 好友列表移除，下次 enrichment 会再次通过 addRival 恢复。
4. DXNet worker 请求好友详情 recent event 页面。
5. 解析最近事件中的 FC/AP/FS/FDX，得到本次 recent event 返回的 FC/FS list。
6. 只处理本次 enrichment 与上一次 enrichment 之间的事件；首次 enrichment 没有 since 时处理当前页面返回的全部 recent event。
7. 不需要和上一次 recent event 结果做 diff；直接把本次 list 与用户当前成绩合并。
8. 合并时按 rank 升级，不覆盖已有更高 FC/FS。
9. 如果某条 recent event 的 `songName + difficulty` 在用户当前成绩里匹配到多个 musicId，视为 ambiguous：
   - 该条 recent event 不直接写 FC/FS。
   - 收集它的 difficulty。
   - 本次 enrichment 完成后触发一次指定难度的 DXNet `update_score` fallback。
   - fallback 使用刚刚 FC/FS enrichment 已完成的 `addRival` 关系，并只抓 ambiguous 对应难度。

输出：

- 最近 FC/FS 增量。
- `lastRecentEventAt`。
- ambiguous difficulty fallback `update_score` job（如有）。

## 解耦要求

- Rival Score Probe 失败不写 sync。
- Map Auxiliary Probe 失败不影响已有成绩。
- FC/FS Enrichment 失败不影响已经写入的 achievement / dxScore。
- 三类任务都需要单独记录错误和 backoff。
