# Failover 与 MaintenanceHook 状态机

[← 返回总览](./README.md)

## 1. 原则

控制面只管理目标 worker 的 membership 与 lane coverage，不实现设备操作：

```text
drain target member
→ verify non-target coverage
→ hookMayRun
→ MaintenanceHook
→ target health verification
→ restore desired membership
```

Router reboot 是 Recoverable 可配置的一种 `MaintenanceHook`。Hook 不操作 BullMQ、Redis membership key，也不选择其他 worker。

## 2. Hook Adapter Registry

控制面/Orchestrator 维护简单 registry：

```ts
interface MaintenanceHookAdapter {
  kind: string;
  execute(input: {
    requestId: string;
    targetWorkerId: string;
    abortSignal: AbortSignal;
  }): Promise<{
    accepted: boolean;
    externalOperationId?: string;
  }>;
  resume(input: {
    requestId: string;
    externalOperationId?: string;
  }): Promise<HookObservation>;
}
```

Recoverable heartbeat 的 `autoRecoveryHookKind` 必须能在 registry 中解析。Router reboot adapter 和云端换 IP workflow 都实现同一接口；新增 kind 不修改 lane、membership、retry、健康验证或 coverage 逻辑。

Hook 可以在 worker 外部异步执行。`externalOperationId` 只用于 adapter 在 orchestrator 重启后恢复/查询同一次操作；不得因超时直接创建第二次操作。本规格不定义设备或云平台 API 的地址、调用格式、认证或加密实现。

## 3. Maintenance 状态

```text
requested
→ planning_coverage
→ draining_target
→ coverage_activating
→ coverage_ready
→ hook_running
→ recovery_verifying
→ restoring_membership
→ completed

pre-hook failure  → aborted
post-hook failure → degraded_coverage_active
```

Maintenance 只作用于 `targetWorkerId`。其他 active member 不进入 drain。

## 4. Coverage 定义与 Hook Gate

对 maintenance 的每条 affected lane，`coverage_ready` 必须同时满足：

1. 目标 worker 已停止该 lane 的新 claim。
2. 至少一个非目标 worker 持有 active membership 并在 heartbeat 报告 active。
3. 非目标 worker 的 class 符合 `LanePolicy`。
4. 没有公网 IP 冲突、breaker open 或 pending drain。

Class 选择规则不因 maintenance 改变：

- 目标以外仍有 preferred active member：由它们继续消费，不激活 fallback。
- 目标是最后一个 preferred active member：激活最多 `fallbackActiveCount` 个 fallback member。
- preferred active count 大于 `0` 时，即使低于 `preferredActiveCount`，也不用 fallback 补数。

只有全部 affected lane 达到 coverage_ready，API 才返回 `hookMayRun=true`。计划内 maintenance 在 deadline 前无法建立 coverage 时进入 aborted，Hook 不执行。

## 5. Orchestrator/Hook 契约

Orchestrator：

1. 生成唯一 requestId。
2. 创建 maintenance run。
3. 等待 `hookMayRun=true`。
4. 执行 hook。
5. 主动、幂等提交 observation。
6. 等待控制面健康验证和 membership 恢复。

Hook 只返回非敏感摘要：

```ts
type HookObservation = {
  requestId: string;
  hookAccepted: boolean;
  connectivityRestored: boolean;
  publicIpBefore?: string;
  publicIpAfter?: string;
  completedAt: string;
};
```

控制面不轮询设备，也不根据 `connectivityRestored` 直接恢复 membership。最终判断来自独立健康 gate。

## 6. Recoverable Empty Failover

某个 Recoverable member 达到 empty threshold：

```text
breaker open on target
→ target closes local request gate
→ target pauses its lane consumers
→ target requeues safe Probe jobs
→ durable incident
→ remove only target memberships
→ reconcile each affected lane
```

Probe 有两种分支：

### 6.1 仍有 Recoverable Active Member

```text
other Recoverable members keep consuming Probe
→ Stable remains Probe-inactive
→ coverage_ready
→ execute target's Auto Recovery hook
```

如果存在其他 eligible Recoverable，可从同 class 补足到 `preferredActiveCount`。补足过程不影响当前 active member。

### 6.2 Recoverable Active Count 变为 0

```text
activate up to fallbackActiveCount Stable members
→ confirm their Probe memberships active
→ coverage_ready
→ execute target's Auto Recovery hook
```

Stable 接管期间，每个 Stable 的 Interactive 优先级和 global 1.5 QPS 不变；Probe 只使用该 worker 的空闲 token。

## 7. Breaker 与 Recovery 参数

```text
empty threshold = 3 consecutive within 10s
half-open concurrency = 1
health successes = 3
health interval = 10s
clean observation window = 60s
cooldown after failure = 1/2/5/10/15min
Auto Recovery budget = once per 30min per Recoverable
```

Auto Recovery 或验证再次失败：

- 保留当前非目标 coverage。
- 不把目标 worker 加回 desired member set。
- 30 分钟内不再次自动执行该 worker 的 hook。
- Maintenance 进入 `degraded_coverage_active` 并报警。

## 8. 恢复 Preferred Coverage

目标 Recoverable 通过健康 gate 后重新成为 eligible：

```text
reconciler selects preferred members up to configured count
→ selected Recoverable acquires Probe membership
→ confirm at least one Recoverable active
→ Stable Probe consumers pause new claims
→ Stable finishes/requeues claimed Probe jobs
→ Stable releases Probe memberships
```

目标 worker 只在 policy 选中且有名额时重新 active；如果同 class 已有足够健康成员，不为恢复目标而强制替换，避免额外抖动。

Preferred 确认 active 到 fallback pause 必须由同一个 reconcile transition 驱动。Fallback 可以短暂保留 draining membership 来完成既有 job，但不能领取新 job。

## 9. Stable 故障

Interactive 使用完全对称的 member-set 规则：

- 一个 Stable 故障但仍有其他 Stable active：只移除故障 member，Recoverable 不消费 Interactive。
- 可用 Stable active count 为 `0`：激活最多 `fallbackActiveCount` 个 Recoverable 来消费 Interactive，并报警 `interactive_on_recoverable`。
- Stable 恢复且至少一个 Stable membership active：Recoverable pause Interactive 新 claim，drain 后释放 membership。

Stable 不执行 Auto Recovery hook。

## 10. 计划内 Router Maintenance

定时或手工 router maintenance 与 empty recovery 使用同一个状态机：

1. 创建 target worker 的 maintenance run。
2. 只让 target 的 affected lane 进入 drain。
3. 如果另有 preferred member，确认其继续 active。
4. 如果 target 是最后一个 preferred member，先激活 fallback coverage。
5. 确认 target 无新 claim 且 coverage_ready。
6. 执行 hook。
7. 验证 target，并由 policy 决定是否重新加入 member set。

无法建立非目标 coverage 时取消计划内 hook。Maintenance 不对其他 worker 使用 BullMQ global pause。

## 11. Worker 故障

Worker heartbeat stale 或 membership renew 失败：

1. 只等待该 worker 的 member key TTL 到期，不删除其他 member key。
2. Remaining member 继续消费。
3. 同 class 有 eligible 候选时补足 configured count。
4. Preferred active count 为 `0` 时激活 fallback set。
5. 旧 active job 由 BullMQ stalled recovery 和 execution fence 处理。
6. 旧 worker 恢复后重新 heartbeat，以新 epoch 申请 policy 选中的 membership。

目标：需要新增 member 时，stale + membership expiry + activation p95 < 45s。若同 lane 尚有 active member，服务不等待该流程。

## 12. Graceful Worker Upgrade

```text
create deployment maintenance
→ pause target's new claims
→ confirm remaining or fallback coverage
→ target jobs reach safe point
→ release target memberships
→ stop old process
→ start and verify new process
→ reconcile desired member sets
```

其他 active member 全程继续消费。目标 worker 没有替代 coverage 时，计划内升级不进入 stop。

Worker drain 结果：

```text
drained
cleanup_handoff_ready
blocked
```

`blocked` 中止升级，禁止用短 timeout 强杀用户 job。

## 13. 超时

| 阶段                          |  默认 |
| ----------------------------- | ----: |
| Coverage planning             |   10s |
| Read-only drain grace         |   30s |
| Membership activation         |   30s |
| Network recovery verification |  5min |
| Membership restoration        |   30s |
| Whole maintenance             | 10min |

Hook 自身必须有上限；hook 已执行但 orchestration 中断时，恢复后进入 verification，不能重复执行。
