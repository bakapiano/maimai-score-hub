import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model, PipelineStage } from 'mongoose';

import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import { RedisService } from '../../../common/redis/redis.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import type { JobResponse } from '../../job/job.types';
import { JobService } from '../../job/services/job.service';
import { ObservabilityIngestService } from '../../observability/services/observability-ingest.service';
import { ScoreChangeHistoryService } from '../../sync/services/score-change-history.service';
import { AutoUpdateProbeStateEntity } from '../schemas/auto-update-probe-state.schema';
import { AutoUpdateRunEntity } from '../schemas/auto-update-run.schema';
import { AutoUpdateTaskEntity } from '../schemas/auto-update-task.schema';
import { AutoUpdateSchedulerTimingService } from './auto-update-scheduler-timing.service';

const HALF_HOUR_MS = 30 * 60_000;
const WINDOW_RUN_PREFIX = 'fcfs-score-window';
const DRAIN_LEASE_NAME = 'auto-update-fcfs-drain';
const DRAIN_BUCKET_KEY = 'dxnet:auto-fcfs:leaky-bucket';
const STAGE_CHUNK_SIZE = 500;
const FCFS_TASK_TYPE = 'fcfs_enrichment' as const;
const FCFS_JOB_SOURCE = 'auto_update_fcfs_score_window';

export type FcfsScoreWindow = { start: Date; end: Date; key: string };
export type FcfsWindowSummary = {
  windowKey: string;
  changedUsers: number;
};
export type FcfsDrainSummary = {
  healthyBots: number;
  ratePerMinute: number;
  reconciled: number;
  due: number;
  dispatched: number;
  deferred: number;
  rateLimited: number;
  failed: number;
};

type FcfsDispatchResult = 'dispatched' | 'deferred' | 'rate_limited' | 'failed';
type ObservabilityAttrs = Record<
  string,
  string | number | boolean | Array<string | number | boolean | null> | null
>;

export function latestClosedFcfsWindow(now: Date): FcfsScoreWindow {
  const endMs = Math.floor(now.getTime() / HALF_HOUR_MS) * HALF_HOUR_MS;
  const end = new Date(endMs);
  return {
    start: new Date(endMs - HALF_HOUR_MS),
    end,
    key: end.toISOString().slice(0, 16),
  };
}

@Injectable()
export class AutoUpdateFcfsWindowService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AutoUpdateFcfsWindowService.name);
  private drainTimer: NodeJS.Timeout | null = null;
  private drainRunning = false;

  constructor(
    @InjectModel(AutoUpdateProbeStateEntity.name)
    private readonly stateModel: Model<AutoUpdateProbeStateEntity>,
    @InjectModel(AutoUpdateTaskEntity.name)
    private readonly taskModel: Model<AutoUpdateTaskEntity>,
    @InjectModel(AutoUpdateRunEntity.name)
    private readonly runsModel: Model<AutoUpdateRunEntity>,
    private readonly jobs: JobService,
    private readonly scoreChanges: ScoreChangeHistoryService,
    private readonly botStatus: BotStatusService,
    private readonly observability: ObservabilityIngestService,
    private readonly timing: AutoUpdateSchedulerTimingService,
    private readonly leases: RedisLeaseService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.drainTimer = setInterval(() => {
      void this.runScheduledDrain();
    }, this.timing.fcfsDrainIntervalMs);
    this.drainTimer.unref?.();
    this.logger.log(
      `Targeted FC/FS drain started (interval=${this.timing.fcfsDrainIntervalMs}ms, baseRate=${this.timing.fcfsRatePerMinute}/min, burst=${this.timing.fcfsBurst})`,
    );
  }

  onModuleDestroy(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  async run(now: Date, signal?: AbortSignal): Promise<FcfsWindowSummary> {
    const window = latestClosedFcfsWindow(now);
    if (!this.timing.fcfsEnabled) {
      return {
        windowKey: window.key,
        changedUsers: 0,
      };
    }
    const changedUsers = await this.stageWindowLeased(window, now, signal);
    if (changedUsers > 0) {
      this.recordStructuredEvent('auto_update_fcfs_window_staged', now, {
        windowKey: window.key,
        changedUsers,
      });
    }
    return { windowKey: window.key, changedUsers };
  }

  async runDrainOnce(
    now = new Date(),
    outerSignal?: AbortSignal,
  ): Promise<FcfsDrainSummary | null> {
    if (!this.timing.fcfsEnabled) {
      return null;
    }
    const result = await this.leases.run(
      {
        name: DRAIN_LEASE_NAME,
        ttlMs: this.timing.leaseTtlMs,
        renewEveryMs: this.timing.leaseRenewEveryMs,
        hardTimeoutMs: this.timing.sweepHardTimeoutMs,
        abortGraceMs: this.timing.sweepAbortGraceMs,
      },
      ({ signal }) => this.runDrain(now, outerSignal, signal),
    );
    return result.acquired ? result.value : null;
  }

  private async runScheduledDrain(): Promise<void> {
    if (this.drainRunning || !this.timing.fcfsEnabled) {
      return;
    }
    this.drainRunning = true;
    try {
      const summary = await this.runDrainOnce();
      if (summary && (summary.dispatched > 0 || summary.failed > 0)) {
        this.logger.log(
          `targeted FC/FS drain: bots=${summary.healthyBots}, rate=${summary.ratePerMinute}/min, due=${summary.due}, dispatched=${summary.dispatched}, deferred=${summary.deferred}, rateLimited=${summary.rateLimited}, failed=${summary.failed}, reconciled=${summary.reconciled}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `targeted FC/FS drain failed: ${this.errorMessage(error)}`,
      );
    } finally {
      this.drainRunning = false;
    }
  }

  private async runDrain(
    now: Date,
    outerSignal?: AbortSignal,
    leaseSignal?: AbortSignal,
  ): Promise<FcfsDrainSummary> {
    this.assertActive(outerSignal, leaseSignal);
    const reconciled = await this.reconcileProcessingTasks(now, leaseSignal);
    this.assertActive(outerSignal, leaseSignal);
    const healthyBots = (await this.botStatus.getHealthyBots(null)).length;
    const ratePerMinute = this.timing.fcfsRateForHealthyBots(healthyBots);
    if (ratePerMinute <= 0) {
      return this.finishDrain(now, {
        healthyBots,
        ratePerMinute,
        reconciled,
        due: 0,
        dispatched: 0,
        deferred: 0,
        rateLimited: 0,
        failed: 0,
      });
    }
    const states = await this.stateModel
      .find({
        enabled: true,
        'pendingFcfsMusicIds.0': { $exists: true },
        $and: [
          {
            $or: [
              { nextFcfsUpdateAt: null },
              { nextFcfsUpdateAt: { $lte: now } },
            ],
          },
          {
            $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
          },
        ],
      })
      .sort({ nextFcfsUpdateAt: 1, pendingFcfsRequestedAt: 1 })
      .limit(this.timing.fcfsDrainScanLimit)
      .lean<AutoUpdateProbeStateEntity[]>()
      .exec();
    const results = await this.dispatchStates(
      states,
      now,
      ratePerMinute,
      healthyBots,
      leaseSignal,
    );
    return this.finishDrain(now, {
      healthyBots,
      ratePerMinute,
      reconciled,
      due: states.length,
      dispatched: results.filter((result) => result === 'dispatched').length,
      deferred: results.filter((result) => result === 'deferred').length,
      rateLimited: results.filter((result) => result === 'rate_limited').length,
      failed: results.filter((result) => result === 'failed').length,
    });
  }

  private async stageWindowLeased(
    window: FcfsScoreWindow,
    now: Date,
    outerSignal?: AbortSignal,
  ): Promise<number> {
    const result = await this.leases.run(
      {
        name: `${WINDOW_RUN_PREFIX}-trigger:${window.key}`,
        ttlMs: this.timing.leaseTtlMs,
        renewEveryMs: this.timing.leaseRenewEveryMs,
        hardTimeoutMs: this.timing.sweepHardTimeoutMs,
        abortGraceMs: this.timing.sweepAbortGraceMs,
      },
      ({ signal }) => this.stageWindow(window, now, outerSignal, signal),
    );
    return result.acquired ? result.value : 0;
  }

  private async stageWindow(
    window: FcfsScoreWindow,
    now: Date,
    outerSignal?: AbortSignal,
    leaseSignal?: AbortSignal,
  ): Promise<number> {
    this.assertActive(outerSignal, leaseSignal);
    const bucketKey = `${WINDOW_RUN_PREFIX}:${window.key}`;
    const existing = await this.runsModel.findOne({ bucketKey }).lean().exec();
    if (existing?.status === 'completed') {
      return 0;
    }
    if (!existing) {
      try {
        await this.runsModel.create({
          bucketKey,
          triggeredAt: now,
          ranOn: process.env.HOSTNAME || 'unknown',
          status: 'running',
          totalUsers: 0,
          triggered: 0,
          skippedNoChange: 0,
          failed: 0,
        });
      } catch (error) {
        if (this.errorMessage(error).includes('E11000')) {
          return 0;
        }
        throw error;
      }
    }
    const changed = await this.scoreChanges.changedScoreChartsByFriendBetween(
      window.start,
      window.end,
    );
    for (let offset = 0; offset < changed.length; offset += STAGE_CHUNK_SIZE) {
      this.assertActive(outerSignal, leaseSignal);
      await this.stateModel.bulkWrite(
        changed.slice(offset, offset + STAGE_CHUNK_SIZE).map((entry) => ({
          updateOne: {
            filter: { friendCode: entry.friendCode, enabled: true },
            update: {
              $addToSet: {
                pendingFcfsMusicIds: { $each: entry.musicIds },
              },
              $set: {
                pendingFcfsWindowStart: window.start,
                pendingFcfsWindowEnd: window.end,
                pendingFcfsRequestedAt: now,
              },
              $inc: { pendingFcfsCount: 1 },
            },
          },
        })),
        { ordered: false },
      );
    }
    await this.runsModel.updateOne(
      { bucketKey },
      {
        $set: {
          status: 'completed',
          totalUsers: changed.length,
          triggered: changed.length,
          skippedNoChange: 0,
          failed: 0,
        },
      },
    );
    return changed.length;
  }

  private async dispatchStates(
    states: AutoUpdateProbeStateEntity[],
    now: Date,
    ratePerMinute: number,
    healthyBots: number,
    signal?: AbortSignal,
  ): Promise<FcfsDispatchResult[]> {
    const results: FcfsDispatchResult[] = [];
    for (const state of states) {
      signal?.throwIfAborted();
      const result = await this.dispatchState(
        state,
        now,
        ratePerMinute,
        healthyBots,
      );
      results.push(result);
      if (result === 'rate_limited') {
        break;
      }
    }
    return results;
  }

  private async reconcileProcessingTasks(
    now: Date,
    signal?: AbortSignal,
  ): Promise<number> {
    const tasks = await this.taskModel
      .find({ type: FCFS_TASK_TYPE, status: 'processing' })
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean<AutoUpdateTaskEntity[]>()
      .exec();
    let reconciled = 0;
    for (const task of tasks) {
      signal?.throwIfAborted();
      if (await this.reconcileTask(task, now)) {
        reconciled++;
      }
    }
    return reconciled;
  }

  private async reconcileTask(
    task: AutoUpdateTaskEntity,
    now: Date,
  ): Promise<boolean> {
    const trackedJobId = this.metricString(task, 'dxnetJobId');
    const tracked = trackedJobId
      ? await this.jobs.findById(trackedJobId)
      : null;
    const job = tracked ?? (await this.jobs.findLatestFcfsUpdate(task.id));
    if (job) {
      return this.reconcileTrackedJob(task, job, now);
    }
    const updatedAt = new Date(task.updatedAt ?? task.createdAt ?? now);
    if (now.getTime() - updatedAt.getTime() < this.timing.fcfsClaimTimeoutMs) {
      return false;
    }
    await this.requeueTask(task, now, 'stale FC/FS dispatch claim');
    return true;
  }

  private async reconcileTrackedJob(
    task: AutoUpdateTaskEntity,
    job: JobResponse,
    now: Date,
  ): Promise<boolean> {
    if (job.status === 'completed') {
      await this.markTaskCompleted(task, job.id, now);
      return true;
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      await this.requeueTask(
        task,
        now,
        job.error ?? `tracked job ${job.status}`,
        job.id,
      );
      return true;
    }
    if (this.metricString(task, 'dxnetJobId') !== job.id) {
      await this.trackJob(task, job.id, 'recovered');
      return true;
    }
    return false;
  }

  private async markTaskCompleted(
    task: AutoUpdateTaskEntity,
    jobId: string,
    now: Date,
  ): Promise<void> {
    await Promise.all([
      this.stateModel.updateOne(
        { friendCode: task.friendCode },
        {
          $set: {
            lastFcfsUpdateAt: now,
            fcfsErrorCount: 0,
          },
        },
      ),
      this.taskModel.updateOne(
        { id: task.id, status: 'processing' },
        {
          $set: {
            status: 'completed',
            runAt: null,
            lastError: null,
            metrics: {
              ...(task.metrics ?? {}),
              dxnetJobId: jobId,
              outcome: 'completed',
            },
          },
        },
      ),
    ]);
    this.observability.recordJobTimelineEvent({
      ts: now,
      jobId,
      jobKind: 'dxnet',
      jobType: 'update_score',
      eventName: 'auto_update_fcfs_completed',
      toStatus: 'completed',
      durationMs: Math.max(
        0,
        now.getTime() - new Date(task.createdAt ?? now).getTime(),
      ),
      attrs: {
        taskId: task.id,
        cidCount: this.metricStringArray(task, 'musicIds').length,
      },
    });
  }

  private async requeueTask(
    task: AutoUpdateTaskEntity,
    now: Date,
    error: string,
    previousJobId?: string,
  ): Promise<void> {
    const musicIds = this.metricStringArray(task, 'musicIds');
    const failureCount = (this.metricNumber(task, 'failureCount') ?? 0) + 1;
    const retryAt = new Date(
      now.getTime() + this.timing.fcfsRetryDelayMs(failureCount),
    );
    const stateUpdate: Record<string, unknown> = {
      $set: {
        nextFcfsUpdateAt: retryAt,
        pendingFcfsRequestedAt: now,
        fcfsErrorCount: failureCount,
      },
      $inc: { pendingFcfsCount: 1 },
    };
    if (musicIds.length) {
      stateUpdate.$addToSet = {
        pendingFcfsMusicIds: { $each: musicIds },
      };
    }
    await Promise.all([
      this.stateModel.updateOne({ friendCode: task.friendCode }, stateUpdate),
      this.taskModel.updateOne(
        { id: task.id, status: 'processing' },
        {
          $set: {
            status: 'failed',
            runAt: null,
            lastError: error,
            metrics: {
              ...(task.metrics ?? {}),
              dxnetJobId: null,
              ...(previousJobId ? { previousJobId } : {}),
              outcome: 'retry_scheduled',
            },
          },
        },
      ),
    ]);
    if (previousJobId) {
      this.observability.recordJobTimelineEvent({
        ts: now,
        jobId: previousJobId,
        jobKind: 'dxnet',
        jobType: 'update_score',
        eventName: 'auto_update_fcfs_requeued',
        toStatus: 'failed',
        errorClass: 'fcfs_job_failed',
        message: error,
        attrs: {
          taskId: task.id,
          cidCount: musicIds.length,
          failureCount,
          retryAt: retryAt.toISOString(),
        },
      });
    }
  }

  private async trackJob(
    task: AutoUpdateTaskEntity,
    jobId: string,
    outcome: string,
  ): Promise<void> {
    await this.taskModel.updateOne(
      { id: task.id, status: 'processing' },
      {
        $set: {
          metrics: {
            ...(task.metrics ?? {}),
            dxnetJobId: jobId,
            outcome,
          },
          lastError: null,
        },
      },
    );
  }

  private async dispatchState(
    state: AutoUpdateProbeStateEntity,
    now: Date,
    ratePerMinute: number,
    healthyBots: number,
  ): Promise<FcfsDispatchResult> {
    const pendingMusicIds = [...new Set(state.pendingFcfsMusicIds ?? [])];
    if (!pendingMusicIds.length) {
      return 'deferred';
    }
    if (await this.jobs.getActiveUpdateScoreByFriendCode(state.friendCode)) {
      return 'deferred';
    }
    const permit = await this.acquireProducerSlot(ratePerMinute);
    if (!permit.allowed) {
      this.recordStructuredEvent('auto_update_fcfs_rate_limited', now, {
        effectiveRatePerMinute: ratePerMinute,
        healthyBots,
        retryAfterMs: permit.retryAfterMs,
      });
      return 'rate_limited';
    }
    const musicIds = pendingMusicIds.slice(
      0,
      this.timing.fcfsMaxMusicIdsPerJob,
    );
    const remainingMusicIds = pendingMusicIds.length - musicIds.length;
    const nextDelayMs = remainingMusicIds
      ? this.timing.fcfsContinuationDelayMs
      : this.timing.fcfsCooldownMs;

    const taskId = randomUUID();
    const taskMetrics = {
      source: 'score_change_window',
      musicIds,
      windowStart: state.pendingFcfsWindowStart?.toISOString() ?? null,
      windowEnd: state.pendingFcfsWindowEnd?.toISOString() ?? null,
      failureCount: state.fcfsErrorCount ?? 0,
      outcome: 'claiming',
    };
    const taskSnapshot = {
      id: taskId,
      type: FCFS_TASK_TYPE,
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: 0,
      runAt: now,
      attempts: 1,
      lastError: null,
      metrics: taskMetrics,
      createdAt: now,
      updatedAt: now,
    } as AutoUpdateTaskEntity;
    await this.taskModel.create(taskSnapshot);
    await this.stateModel.updateOne(
      { friendCode: state.friendCode },
      {
        $pullAll: { pendingFcfsMusicIds: musicIds },
        $set: {
          nextFcfsUpdateAt: new Date(now.getTime() + nextDelayMs),
        },
      },
    );
    try {
      const created = await this.jobs.create({
        friendCode: state.friendCode,
        jobType: 'update_score',
        source: 'auto_update',
        musicIds,
        fcfsOnly: true,
        cancelActiveJobs: false,
        context: {
          source: FCFS_JOB_SOURCE,
          autoUpdateFcfs: true,
          fcfsTaskId: taskId,
          windowStart: state.pendingFcfsWindowStart?.toISOString() ?? null,
          windowEnd: state.pendingFcfsWindowEnd?.toISOString() ?? null,
        },
      });
      await this.trackJob(taskSnapshot, created.jobId, 'dispatched').catch(
        (error) =>
          this.logger.warn(
            `failed to track targeted FC/FS job ${created.jobId}: ${this.errorMessage(error)}`,
          ),
      );
      this.observability.recordJobTimelineEvent({
        ts: now,
        jobId: created.jobId,
        jobKind: 'dxnet',
        jobType: 'update_score',
        eventName: 'auto_update_fcfs_dispatched',
        toStatus: 'queued',
        attrs: {
          taskId,
          cidCount: musicIds.length,
          remainingCidCount: remainingMusicIds,
          effectiveRatePerMinute: ratePerMinute,
          healthyBots,
          dueAgeMs: this.ageMs(now, state.nextFcfsUpdateAt),
          pendingAgeMs: this.ageMs(now, state.pendingFcfsRequestedAt),
        },
      });
      return 'dispatched';
    } catch (error) {
      const message = this.errorMessage(error);
      await this.requeueTask(taskSnapshot, now, message);
      this.logger.warn(
        `failed to dispatch targeted FC/FS update fc=${state.friendCode}: ${message}`,
      );
      return 'failed';
    }
  }

  private acquireProducerSlot(ratePerMinute: number) {
    return this.redis.tryAcquireLeakyBucket(
      this.redis.key(DRAIN_BUCKET_KEY),
      60_000 / ratePerMinute,
      this.timing.fcfsBurst,
    );
  }

  private async finishDrain(
    now: Date,
    summary: FcfsDrainSummary,
  ): Promise<FcfsDrainSummary> {
    this.recordStructuredEvent('auto_update_fcfs_drain_tick', now, {
      ...summary,
    });
    await this.recordBacklogSnapshotOnce(now, summary);
    return summary;
  }

  private async recordBacklogSnapshotOnce(
    now: Date,
    summary: FcfsDrainSummary,
  ): Promise<void> {
    const minute = now.toISOString().slice(0, 16);
    try {
      const won = await this.redis.setNx(
        this.redis.key(`observability:auto-fcfs:snapshot:${minute}`),
        '1',
        120_000,
      );
      if (!won) {
        return;
      }
      const snapshotPipeline = [
        {
          $match: {
            enabled: true,
            'pendingFcfsMusicIds.0': { $exists: true },
          },
        },
        {
          $project: {
            pendingCidCount: { $size: '$pendingFcfsMusicIds' },
            due: {
              $and: [
                {
                  $or: [
                    { $eq: ['$nextFcfsUpdateAt', null] },
                    { $lte: ['$nextFcfsUpdateAt', now] },
                  ],
                },
                {
                  $or: [
                    { $eq: ['$backoffUntil', null] },
                    { $lte: ['$backoffUntil', now] },
                  ],
                },
              ],
            },
            dueAgeMs: {
              $subtract: [
                now,
                {
                  $ifNull: ['$nextFcfsUpdateAt', '$pendingFcfsRequestedAt'],
                },
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            pendingUsers: { $sum: 1 },
            dueUsers: { $sum: { $cond: ['$due', 1, 0] } },
            pendingCidCount: { $sum: '$pendingCidCount' },
            oldestDueAgeMs: {
              $max: { $cond: ['$due', '$dueAgeMs', 0] },
            },
            dueAgePercentilesMs: {
              $percentile: {
                input: { $cond: ['$due', '$dueAgeMs', null] },
                p: [0.5, 0.95],
                method: 'approximate',
              },
            },
          },
        },
      ] as unknown as PipelineStage[];
      const [snapshot] = await this.stateModel
        .aggregate<{
          pendingUsers: number;
          dueUsers: number;
          pendingCidCount: number;
          oldestDueAgeMs: number;
          dueAgePercentilesMs: number[];
        }>(snapshotPipeline)
        .exec();
      this.recordStructuredEvent('auto_update_fcfs_backlog_snapshot', now, {
        pendingUsers: snapshot?.pendingUsers ?? 0,
        dueUsers: snapshot?.dueUsers ?? 0,
        pendingCidCount: snapshot?.pendingCidCount ?? 0,
        oldestDueAgeMs: snapshot?.oldestDueAgeMs ?? 0,
        p50DueAgeMs: snapshot?.dueAgePercentilesMs?.[0] ?? 0,
        p95DueAgeMs: snapshot?.dueAgePercentilesMs?.[1] ?? 0,
        healthyBots: summary.healthyBots,
        effectiveRatePerMinute: summary.ratePerMinute,
      });
    } catch (error) {
      this.logger.warn(
        `failed to record targeted FC/FS backlog snapshot: ${this.errorMessage(error)}`,
      );
    }
  }

  private recordStructuredEvent(
    eventName: string,
    at: Date,
    attrs: ObservabilityAttrs,
  ): void {
    this.observability.recordStructuredLogs({
      service: 'backend',
      workerKind: 'backend',
      entries: [
        {
          ts: at.toISOString(),
          level: 'log',
          eventName,
          message: eventName,
          attrs,
        },
      ],
    });
  }

  private ageMs(now: Date, value?: Date | null): number {
    if (!value) {
      return 0;
    }
    return Math.max(0, now.getTime() - new Date(value).getTime());
  }

  private assertActive(...signals: Array<AbortSignal | undefined>): void {
    for (const signal of signals) {
      signal?.throwIfAborted();
    }
  }

  private metricString(task: AutoUpdateTaskEntity, key: string): string | null {
    const value = task.metrics?.[key];
    return typeof value === 'string' ? value : null;
  }

  private metricNumber(task: AutoUpdateTaskEntity, key: string): number | null {
    const value = task.metrics?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private metricStringArray(task: AutoUpdateTaskEntity, key: string): string[] {
    const value = task.metrics?.[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
