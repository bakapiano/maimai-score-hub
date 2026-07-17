import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import type {
  CreateSdgbMaintenanceRequest,
  SdgbHookObservation,
  SdgbMaintenanceState,
  SdgbWorkerLane,
} from '@maimai-score-hub/shared';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';

import { RedisService } from '../../../common/redis/redis.service';
import {
  SdgbMaintenanceRunEntity,
  type SdgbMaintenanceRunDocument,
} from '../schemas/sdgb-maintenance-run.schema';
import { SdgbWorkerRegistryService } from './sdgb-worker-registry.service';

const TERMINAL_STATES: readonly SdgbMaintenanceState[] = [
  'completed',
  'aborted',
  'degraded_coverage_active',
];
const RECONCILE_INTERVAL_MS = 5_000;
const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
const DEFAULT_CLEAN_WINDOW_MS = 60_000;

export interface SdgbMaintenanceView extends SdgbMaintenanceRunEntity {
  hookMayRun: boolean;
}

@Injectable()
export class SdgbMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SdgbMaintenanceService.name);
  private readonly healthIntervalMs: number;
  private readonly cleanWindowMs: number;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(SdgbMaintenanceRunEntity.name)
    private readonly model: Model<SdgbMaintenanceRunDocument>,
    private readonly redis: RedisService,
    private readonly registry: SdgbWorkerRegistryService,
    config: ConfigService,
  ) {
    this.healthIntervalMs = positiveInt(
      config.get<string | number>('SDGB_RECOVERY_HEALTH_INTERVAL_MS'),
      DEFAULT_HEALTH_INTERVAL_MS,
    );
    this.cleanWindowMs = positiveInt(
      config.get<string | number>('SDGB_RECOVERY_CLEAN_WINDOW_MS'),
      DEFAULT_CLEAN_WINDOW_MS,
    );
  }

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logger.warn(
          'Maintenance reconcile failed: ' + errorMessage(error),
        );
      });
    }, RECONCILE_INTERVAL_MS);
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async create(
    request: CreateSdgbMaintenanceRequest,
  ): Promise<SdgbMaintenanceView> {
    const existing = await this.model
      .findOne({ requestId: request.requestId })
      .lean<SdgbMaintenanceRunEntity>();
    if (existing) {
      if (!sameRequest(existing, request)) {
        throw new ConflictException(
          'maintenance requestId already has different parameters',
        );
      }
      return this.toView(existing);
    }
    const active = await this.model
      .findOne({
        targetWorkerId: request.targetWorkerId,
        state: { $nin: TERMINAL_STATES },
      })
      .lean<SdgbMaintenanceRunEntity>();
    if (active) {
      throw new ConflictException(
        'target worker already has active maintenance',
      );
    }
    const worker = (await this.registry.listWorkers()).find(
      (candidate) => candidate.workerId === request.targetWorkerId,
    );
    if (!worker) {
      throw new NotFoundException('sdgb worker not found');
    }
    if (
      worker.workerClass !== 'recoverable' ||
      worker.autoRecoveryHookKind !== request.hookKind
    ) {
      throw new ConflictException(
        'maintenance hook does not match recoverable worker configuration',
      );
    }
    if (request.reason === 'network_recovery') {
      const budgetKey = this.redis.key(
        'sdgb:workers:' + request.targetWorkerId + ':recovery-budget',
      );
      if (
        !(await this.redis.setNx(budgetKey, request.requestId, 30 * 60 * 1000))
      ) {
        throw new ConflictException(
          'auto recovery budget is limited to once per 30 minutes',
        );
      }
    }

    const before = await this.activeMembersByLane(request.affectedLanes);
    const now = new Date();
    const created = await this.model.create({
      ...request,
      affectedLanes: unique(request.affectedLanes),
      deadlineAt: new Date(request.deadlineAt),
      state: 'planning_coverage',
      coveragePlanByLane: {},
      activeMembersBeforeByLane: before,
      activeMembersAtHookByLane: {},
      activeMembersAfterByLane: {},
      hookObservation: null,
      healthSuccesses: 0,
      healthFailures: 0,
      healthWindowStartedAt: null,
      healthLastCheckedAt: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.redis.setJson(
      this.drainKey(request.targetWorkerId),
      {
        requestId: request.requestId,
        reason: request.reason,
        affectedLanes: unique(request.affectedLanes),
      },
      {
        ttlSeconds: Math.max(
          60,
          Math.ceil(
            (new Date(request.deadlineAt).getTime() - Date.now()) / 1000,
          ),
        ),
      },
    );
    await this.registry.reconcile();
    await this.advanceCoverage(created.toObject() as SdgbMaintenanceRunEntity);
    return this.get(request.requestId);
  }

  async get(requestId: string): Promise<SdgbMaintenanceView> {
    const run = await this.model
      .findOne({ requestId })
      .lean<SdgbMaintenanceRunEntity>();
    if (!run) {
      throw new NotFoundException('sdgb maintenance run not found');
    }
    return this.toView(run);
  }

  async observe(
    requestId: string,
    observation: SdgbHookObservation,
  ): Promise<SdgbMaintenanceView> {
    const run = await this.model
      .findOne({ requestId })
      .lean<SdgbMaintenanceRunEntity>();
    if (!run) {
      throw new NotFoundException('sdgb maintenance run not found');
    }
    if (run.state !== 'coverage_ready' && run.state !== 'hook_running') {
      if (
        run.hookObservation &&
        sameObservation(run.hookObservation, observation)
      ) {
        return this.toView(run);
      }
      throw new ConflictException(
        'maintenance is not ready for hook observation',
      );
    }
    const now = new Date();
    if (!observation.hookAccepted) {
      await this.model.updateOne(
        { requestId, state: run.state },
        {
          $set: {
            state: 'aborted',
            hookObservation: observation,
            errorCode: 'HOOK_NOT_ACCEPTED',
            completedAt: now,
            updatedAt: now,
          },
        },
      );
      await this.redis.del(this.drainKey(run.targetWorkerId));
      await this.redis.del(this.recoveryKey(run.targetWorkerId));
      await this.registry.reconcile();
      return this.get(requestId);
    }
    if (!observation.connectivityRestored) {
      await this.model.updateOne(
        { requestId, state: run.state },
        {
          $set: {
            state: 'degraded_coverage_active',
            hookObservation: observation,
            errorCode: 'CONNECTIVITY_NOT_RESTORED',
            completedAt: now,
            updatedAt: now,
          },
        },
      );
      await this.registry.reconcile();
      return this.get(requestId);
    }

    await this.model.updateOne(
      { requestId, state: run.state },
      {
        $set: {
          state: 'recovery_verifying',
          hookObservation: observation,
          healthSuccesses: 0,
          healthFailures: 0,
          healthWindowStartedAt: now,
          healthLastCheckedAt: null,
          updatedAt: now,
        },
      },
    );
    await this.redis.del(this.drainKey(run.targetWorkerId));
    await this.redis.setJson(
      this.recoveryKey(run.targetWorkerId),
      {
        requestId,
        state: 'verifying',
      },
      {
        ttlSeconds: Math.max(
          60,
          Math.ceil((run.deadlineAt.getTime() - Date.now()) / 1000),
        ),
      },
    );
    await this.registry.reconcile();
    return this.get(requestId);
  }

  private async reconcile(): Promise<void> {
    const lockKey = this.redis.key('sdgb:control:maintenance-reconcile');
    const token = randomUUID();
    if (
      !(await this.redis.setNx(lockKey, token, RECONCILE_INTERVAL_MS - 250))
    ) {
      return;
    }
    try {
      const runs = await this.model
        .find({ state: { $nin: TERMINAL_STATES } })
        .lean<SdgbMaintenanceRunEntity[]>();
      for (const run of runs) {
        await this.advance(run);
      }
    } finally {
      await this.redis.compareAndDelete(lockKey, token);
    }
  }

  private async advance(run: SdgbMaintenanceRunEntity): Promise<void> {
    if (run.deadlineAt.getTime() <= Date.now()) {
      await this.finishDeadline(run);
      return;
    }
    if (
      run.state === 'requested' ||
      run.state === 'planning_coverage' ||
      run.state === 'draining_target' ||
      run.state === 'coverage_activating'
    ) {
      await this.advanceCoverage(run);
      return;
    }
    if (run.state === 'recovery_verifying') {
      await this.advanceVerification(run);
      return;
    }
    if (run.state === 'restoring_membership') {
      await this.advanceRestoration(run);
    }
  }

  private async advanceCoverage(run: SdgbMaintenanceRunEntity): Promise<void> {
    await this.registry.reconcile();
    const workers = await this.registry.listWorkers();
    const target = workers.find(
      (worker) => worker.workerId === run.targetWorkerId,
    );
    const targetStopped = run.affectedLanes.every(
      (lane) =>
        !target?.laneMemberships.some(
          (membership) =>
            membership.lane === lane && membership.state === 'active',
        ),
    );
    const active = await this.activeMembersByLane(run.affectedLanes);
    const coverageReady = run.affectedLanes.every(
      (lane) =>
        (active[lane] ?? []).filter(
          (workerId) => workerId !== run.targetWorkerId,
        ).length > 0,
    );
    const plans = await this.coveragePlans(run.affectedLanes, active);
    await this.model.updateOne(
      { requestId: run.requestId },
      {
        $set: {
          state:
            targetStopped && coverageReady
              ? 'coverage_ready'
              : targetStopped
                ? 'coverage_activating'
                : 'draining_target',
          coveragePlanByLane: plans,
          ...(targetStopped && coverageReady
            ? { activeMembersAtHookByLane: active }
            : {}),
          updatedAt: new Date(),
        },
      },
    );
  }

  private async advanceVerification(
    run: SdgbMaintenanceRunEntity,
  ): Promise<void> {
    const now = new Date();
    if (
      run.healthLastCheckedAt &&
      now.getTime() - run.healthLastCheckedAt.getTime() < this.healthIntervalMs
    ) {
      return;
    }
    const worker = (await this.registry.listWorkers()).find(
      (candidate) => candidate.workerId === run.targetWorkerId,
    );
    const healthy =
      worker?.upstreamHealth === 'healthy' &&
      worker.breakerState === 'closed' &&
      worker.lifecycleState === 'running';
    const windowStart = healthy ? (run.healthWindowStartedAt ?? now) : now;
    const successes = healthy ? run.healthSuccesses + 1 : 0;
    const failures = healthy ? run.healthFailures : run.healthFailures + 1;
    const ready =
      healthy &&
      successes >= 3 &&
      now.getTime() - windowStart.getTime() >= this.cleanWindowMs;
    await this.model.updateOne(
      { requestId: run.requestId, state: 'recovery_verifying' },
      {
        $set: {
          state: ready ? 'restoring_membership' : 'recovery_verifying',
          healthSuccesses: successes,
          healthFailures: failures,
          healthWindowStartedAt: windowStart,
          healthLastCheckedAt: now,
          updatedAt: now,
        },
      },
    );
    if (ready) {
      await this.redis.del(this.recoveryKey(run.targetWorkerId));
      await this.registry.reconcile();
    }
  }

  private async advanceRestoration(
    run: SdgbMaintenanceRunEntity,
  ): Promise<void> {
    await this.registry.reconcile();
    const [active, workers] = await Promise.all([
      this.activeMembersByLane(run.affectedLanes),
      this.registry.listWorkers(),
    ]);
    const restored = run.affectedLanes.every((lane) => {
      const policy = this.registry.getPolicy(lane);
      return (active[lane] ?? []).some(
        (workerId) =>
          workers.find((worker) => worker.workerId === workerId)
            ?.workerClass === policy.preferredClass,
      );
    });
    if (!restored) {
      return;
    }
    const now = new Date();
    await this.model.updateOne(
      { requestId: run.requestId, state: 'restoring_membership' },
      {
        $set: {
          state: 'completed',
          activeMembersAfterByLane: active,
          completedAt: now,
          updatedAt: now,
        },
      },
    );
  }

  private async finishDeadline(run: SdgbMaintenanceRunEntity): Promise<void> {
    const postHook =
      run.state === 'hook_running' ||
      run.state === 'recovery_verifying' ||
      run.state === 'restoring_membership';
    const now = new Date();
    await this.model.updateOne(
      { requestId: run.requestId, state: run.state },
      {
        $set: {
          state: postHook ? 'degraded_coverage_active' : 'aborted',
          errorCode: 'MAINTENANCE_DEADLINE_EXCEEDED',
          completedAt: now,
          updatedAt: now,
        },
      },
    );
    await Promise.all([
      this.redis.del(this.drainKey(run.targetWorkerId)),
      this.redis.del(this.recoveryKey(run.targetWorkerId)),
    ]);
    await this.registry.reconcile();
  }

  private async activeMembersByLane(
    lanes: readonly SdgbWorkerLane[],
  ): Promise<Partial<Record<SdgbWorkerLane, string[]>>> {
    const result: Partial<Record<SdgbWorkerLane, string[]>> = {};
    for (const lane of lanes) {
      result[lane] = await this.registry.confirmedActiveMemberIds(lane);
    }
    return result;
  }

  private async coveragePlans(
    lanes: readonly SdgbWorkerLane[],
    active: Partial<Record<SdgbWorkerLane, string[]>>,
  ): Promise<SdgbMaintenanceRunEntity['coveragePlanByLane']> {
    const result: SdgbMaintenanceRunEntity['coveragePlanByLane'] = {};
    const workers = await this.registry.listWorkers();
    for (const lane of lanes) {
      const workerIds = active[lane] ?? [];
      const selectedClass = workers.find((worker) =>
        workerIds.includes(worker.workerId),
      )?.workerClass;
      const policy = this.registry.getPolicy(lane);
      result[lane] = {
        workerClass: selectedClass ?? policy.fallbackClass,
        targetCount:
          selectedClass === policy.preferredClass
            ? policy.preferredActiveCount
            : policy.fallbackActiveCount,
        selectedWorkerIds: workerIds,
      };
    }
    return result;
  }

  private drainKey(workerId: string): string {
    return this.redis.key('sdgb:workers:' + workerId + ':drain');
  }

  private recoveryKey(workerId: string): string {
    return this.redis.key('sdgb:workers:' + workerId + ':recovery');
  }

  private toView(run: SdgbMaintenanceRunEntity): SdgbMaintenanceView {
    return {
      ...run,
      hookMayRun: run.state === 'coverage_ready',
    };
  }
}

function sameRequest(
  existing: SdgbMaintenanceRunEntity,
  request: CreateSdgbMaintenanceRequest,
): boolean {
  return (
    existing.targetWorkerId === request.targetWorkerId &&
    existing.hookKind === request.hookKind &&
    existing.reason === request.reason &&
    existing.deadlineAt.toISOString() === request.deadlineAt &&
    JSON.stringify([...existing.affectedLanes].sort()) ===
      JSON.stringify([...request.affectedLanes].sort())
  );
}

function sameObservation(
  existing: SdgbHookObservation,
  incoming: SdgbHookObservation,
): boolean {
  return (
    existing.hookAccepted === incoming.hookAccepted &&
    existing.connectivityRestored === incoming.connectivityRestored &&
    existing.publicIpBefore === incoming.publicIpBefore &&
    existing.publicIpAfter === incoming.publicIpAfter &&
    existing.completedAt === incoming.completedAt
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value: string | number | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
