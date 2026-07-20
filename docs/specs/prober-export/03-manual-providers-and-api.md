# 03 — 手动导出、Provider、API 与可观测性

## 手动导出

接口保持异步：

```text
POST /api/v1/me/sync/latest/exports/diving-fish
POST /api/v1/me/sync/latest/exports/lxns
```

流程：

1. 校验用户和 token；
2. 确保 export state 存在；
3. 立即创建 `kind=manual` attempt；
4. 使用高于 auto wake 的 BullMQ priority；
5. 取得同一 Redis user lease 和 Mongo claim；
6. claim 后读取 execution-time latest；
7. 成功后用 `$max` 推进 provider 游标，避免 scanner 重复上传；
8. 完整结果保存在 manual job，供用户轮询。

查询接口继续按当前用户所有权返回单 job或最近列表。手动与自动不得并发。

## Provider 映射

`ProberExportMapService` 缓存两个平台曲库映射：

- Diving-Fish 主要使用本地标题/类型；
- LXNS 使用 `toLxnsId`；
- 未映射成绩跳过并计数；
- mapping cache 构建失败只使本 provider 失败，不推进成功游标。

## Diving-Fish

```text
POST https://www.diving-fish.com/api/maimaidxprober/player/update_records
Import-Token: <token>
```

Payload 包含 achievements、dxScore、fc、fs、level_index、title、type。网络/5xx 使用后台
长退避，4xx 立即失败。现有“500 + 默认 HTML 页面视作 degraded success”行为保留。

## LXNS

```text
POST https://maimai.lxns.net/api/v0/user/maimai/player/scores
X-User-Token: <token>
```

`fdxp → fsdp`、`fdx → fsd`，`fsp/fs` 原样。每条成绩将 `scores[].observedAt`
作为 `play_time`；旧数据缺少该字段时，同一次导出统一使用 attempt 当前时间。网络/5xx
重试，4xx 立即失败。

## 用户可见状态

`/me/sync/latest` 或独立状态接口投影：

- provider enabled；
- current score version；
- last success version；
- idle/processing/failed；
- 安全文案和最近更新时间。

完整 attempt 结果从 `prober_export_jobs` 查询。Token、claimToken、claimedBy 和内部错误不得
暴露。

## 可观测性

```text
prober_export_reconcile_scanned_total
prober_export_reconcile_mismatch_total{provider}
prober_export_wake_total{source,result}
prober_export_claim_total{result}
prober_export_lease_wait_total
prober_export_attempt_total{kind,provider,result}
prober_export_version_lag{provider}
prober_export_duration_ms{provider}
prober_export_recovery_total{reason}
```

日志包含 attemptId、friendCode 安全表示、requested/exported version、provider、claim 等待
时间；不得记录 token、密码或完整成绩 payload。
