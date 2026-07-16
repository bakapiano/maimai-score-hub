# Failover 与 Router Hook 状态机

[← 返回总览](./README.md)

## 1. 原则

控制面只管理 lane handoff，不实现设备操作：

```text
drain owner
→ standby active
→ hookMayRun
→ MaintenanceHook
→ health verification
→ handback
```

Router reboot 是 Recoverable 配置的 `MaintenanceHook`。Hook 不操作 BullMQ、Redis owner key，也不选择备用 worker。

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

Recoverable heartbeat 的 `autoRecoveryHookKind` 必须能在 registry 中解析。首版至少注册现有 router reboot adapter；Azure 上的 IP 轮换 workflow 可以注册为另一个 kind，例如 `azure_ip_rotate`。新增 adapter 不修改 lane、lease、retry、健康验证或 handback 逻辑。

云 workflow 可以在 worker 外部执行并异步完成。`externalOperationId` 只用于 adapter 在 orchestrator 重启后恢复/查询同一次操作；不得因超时直接创建第二次操作。

## 3. Maintenance 状态

```text
requested
→ selecting_standby
→ draining_owner
→ standby_activating
→ standby_active
→ hook_running
→ recovery_verifying
→ handback
→ completed

pre-hook failure  → aborted
post-hook failure → degraded_standby_active
```

## 4. Orchestrator/Hook 契约

Orchestrator：

1. 生成唯一 requestId。
2. 创建 maintenance run。
3. 等待 `hookMayRun=true`。
4. 执行 hook。
5. 主动、幂等提交 observation。
6. 等待控制面验证和 handback。

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

控制面不轮询设备，也不根据 `connectivityRestored` 直接 handback。

## 5. Recoverable Empty Failover

当前 Recoverable 是 Probe owner，Stable 是 Interactive owner/Probe standby：

```text
Recoverable breaker open
→ pause Probe + requeue Rival/Map
→ durable incident
→ control plane selects Probe standby
→ Recoverable drains/releases Probe lease
→ Stable acquires Probe lease
→ Stable activeLanes=[interactive, probe]
→ hookMayRun=true
→ Router Auto Recovery hook
→ Recoverable network returns
→ health gate
→ Probe handback to Recoverable
```

Stable 接管期间，Interactive 优先级和 global 1.5 QPS 不变；Probe 仅使用空闲 token。

## 6. Breaker 与 Recovery 参数

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

- Stable 保持 Probe owner。
- 不进行 handback。
- 30 分钟内不再次自动执行 hook。
- 记录报警，等待人工处理或下一次允许的 recovery。

## 7. Handback

```text
Recoverable healthy
→ Stable pause Probe only
→ Stable finish/requeue active Probe
→ Stable release Probe lease
→ Recoverable acquire new epoch
→ Recoverable resume Probe
→ Stable remains Interactive owner
```

Handback 失败时保持 Stable owner，不允许双方 resume。

## 8. Stable 故障

Stable 是 Interactive 首选。Stable stale/breaker open：

```text
Stable drain/release Interactive
→ Recoverable acquire Interactive
→ alert interactive_on_recoverable
```

Stable 不执行 Auto Recovery hook。恢复并通过健康验证后，Interactive 按 class priority handback。

## 9. 计划内 Router Reboot

定时/手工 router reboot 与 empty recovery 使用相同状态机：

1. 创建 maintenance run。
2. Stable 接管 Probe。
3. 确认 lease + heartbeat active。
4. 执行 hook。
5. 验证 Recoverable。
6. Handback。

没有健康 Stable 时，取消计划内 reboot，保持 Recoverable owner。

## 10. Worker 故障

Worker 无 heartbeat 或 lease renew：

1. 等待 lease TTL 到期，不强删 owner key。
2. 按 lane class priority 选择候选。
3. 新 worker acquire 新 epoch。
4. Waiting job 继续；旧 active job 由 BullMQ stalled recovery 和 execution fence 处理。
5. 旧 worker 恢复后只作为 standby，不能沿用旧 lease。

目标：stale + lease expiry + activation p95 < 45s。

## 11. Graceful Worker Upgrade

```text
create deployment maintenance
→ pause new claims
→ active jobs reach safe point
→ optional lane handoff
→ stop old process
→ start/verify new process
→ reacquire/handback lanes
```

有 standby 时先完成 lane handoff，再停止旧进程。没有 standby 时 waiting job 在 BullMQ 短暂排队，但 active 用户 job 仍必须 graceful。

Worker drain 结果：

```text
drained
cleanup_handoff_ready
blocked
```

`blocked` 中止升级，禁止用短 timeout 强杀。

## 12. 超时

| 阶段                          |  默认 |
| ----------------------------- | ----: |
| Standby selection             |   10s |
| Read-only drain grace         |   30s |
| Standby activation            |   30s |
| Network recovery verification |  5min |
| Handback activation           |   30s |
| Whole maintenance             | 10min |

Hook 自身必须有上限；hook 已执行但 orchestration 中断时，恢复后进入 verification，不能重复执行。
