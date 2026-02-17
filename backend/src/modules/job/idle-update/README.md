# Idle Update 模块

该目录用于管理“闲时更新（idle update）”相关逻辑，包含调度、触发日志、以及 Worker 侧配套 API。

## 作用

- 定时扫描并触发开启了闲时更新的用户
- 通过数据库原子操作保证同一天只触发一次（多实例场景）
- 按并发批量创建 `idle_update_score` 类型的 job
- 等待所有已创建 job 完成后，统一清除用户的闲时更新标记
- 记录本次触发的统计结果（总用户数、成功数、失败数、job 明细）

## 文件说明

- `idle-update.controller.ts`  
  提供 Worker 调用的 idle-update 相关接口（挂在 `/api/job/*` 下）。

- `idle-update-log.schema.ts`  
  定义 `idle_update_logs` 集合结构，用于记录每日触发日志。

- `idle-update-log.service.ts`  
  提供触发权竞争与日志落库能力：
  - `tryAcquire(dateKey)`：尝试获取当天触发权
  - `finalize(dateKey, summary)`：写入执行摘要

- `idle-update-scheduler.service.ts`  
  调度核心：
  - 模块启动后每分钟检查一次
  - 命中目标时段时触发执行
  - 分批创建任务并等待完成
  - 全部完成后统一清除用户闲时更新标记

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/job/idle-update/mark-ready` | Worker 标记某用户已 ready（写入 bot friendCode） |
| GET | `/api/job/idle-update/friends/:botFriendCode` | 获取分配给指定 bot 的用户 friendCode 列表 |

## 关键流程（简化）

1. 调度器按分钟轮询，判断是否到达 `IDLE_UPDATE_HOUR`（UTC+8）
2. 通过 `tryAcquire(dateKey)` 抢占当天触发权
3. 拉取启用闲时更新的用户并按并发分批创建 job
4. 等待所有创建成功的 job 进入终态（completed/failed/canceled）
5. 统一清除对应用户的 `idleUpdateBotFriendCode`
6. 通过 `finalize` 记录本次触发结果

## 相关配置

- `IDLE_UPDATE_HOUR`：触发小时（UTC+8）
- `IDLE_UPDATE_CONCURRENCY`：每批并发创建 job 数
