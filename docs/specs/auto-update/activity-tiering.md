# 活跃度分层设计

本文档描述 Rival-first 自动更新的目标活跃度分层。分层主要由 `GetUserRivalMusicApi` 的成绩 hash 变化驱动，`GetUserMapApi` 只作为辅助信号。

## 分层

| 档位 | 判定                                                | Rival probe 间隔 | 设计目的                       |
| ---- | --------------------------------------------------- | ---------------: | ------------------------------ |
| hot  | 最近 60-90 分钟内 rival hash 或 map distance 有变化 |          10 分钟 | 覆盖正在游戏厅连续游玩的用户   |
| warm | 最近 7 天内 rival/map 有变化，但当前不在 session    |          30 分钟 | 较快发现近期常玩的用户重新到店 |
| cold | 7 天以上无变化，或新绑定但未观测到活跃              |           1 小时 | 保持可接受冷启动延迟           |

## 状态流转

```text
cold/warm --rival hash changed--> hot
cold/warm --map distance changed--> hot
hot --90min no rival/map delta--> warm
warm --7d no rival/map delta--> cold
```

说明：

- `rival hash changed` 是主信号，代表成绩需要更新。
- `map distance changed` 是辅助信号，代表用户可能在游玩但成绩 hash 未变。
- 不需要按夜间单独降频；夜间自然很少有人被升到 hot。

## 10k 用户 QPS 估算

Rival probe QPS 公式：

```text
hot / 600 + warm / 1800 + cold / 3600
```

| 场景           | 假设分布                         | Rival probe QPS |
| -------------- | -------------------------------- | --------------: |
| 全员 cold 下限 | 10000 cold                       |         2.8 qps |
| 保守平时       | 1000 hot / 5000 warm / 4000 cold |         5.6 qps |
| 日间主峰       | 2500 hot / 6000 warm / 1500 cold |         7.9 qps |
| 极端主峰       | 3500 hot / 5500 warm / 1000 cold |         9.2 qps |

Phase 1 当前代码控制：

```text
AUTO_UPDATE_RIVAL_BATCH_LIMIT = 480
AUTO_UPDATE_RIVAL_CONCURRENCY = 4
```

8 qps sustained / 10-12 qps burst 是 10k 容量目标外推；sdgb-worker 已有 token bucket，backend scheduler 仍通过 batch/concurrency 控制生产节奏。极端主峰允许短暂排队。不要为了极端主峰无限提高 sdgb 并发。

## Phase 2 用户习惯预留

Phase 1 先使用固定三档，但调度实现不要把间隔写死在任务生产逻辑里。应通过一个统一函数计算：

```text
effectiveInterval = clamp(
  baseTierInterval * habitMultiplier * loadMultiplier,
  minInterval,
  maxInterval
)
```

Phase 1 中：

```text
habitMultiplier = 1
loadMultiplier = 1
```

Phase 2 可以接入用户游玩习惯画像，只影响 `nextRivalProbeAt` / `nextMapProbeAt`，不改变 rival score probe、map auxiliary、FC/FS enrichment 的链路语义。

建议 clamp：

| tier |    min |   base |    max |
| ---- | -----: | -----: | -----: |
| hot  | 10 min | 10 min | 20 min |
| warm | 15 min | 30 min | 60 min |
| cold | 30 min | 60 min | 2 hour |

## Map auxiliary 触发

Map 不再承担主探测。当前 Phase 1 代码按 `nextMapProbeAt` 到期执行，间隔由 tier 决定：

```text
hot: 30min
warm: 1h
cold: 1h
```

所有开启自动更新且绑定 cabinet userId 的用户都会初始化 `nextMapProbeAt`；不是只对抽样 cold 用户执行。

Map 变化后：

```text
map distance changed
  -> promote/extend hot
  -> request fcfs_enrichment; if recent event cooldown is active, record pending
```

如果 map 变化且距离上次 rival probe 已超过 tier 间隔，也可以立即触发 rival probe。
