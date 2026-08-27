import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { DXNET_ALL_DIFFICULTIES } from '@maimai-score-hub/shared';

import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import type { JobResponse } from '../../job/job.types';
import { JobService } from '../../job/services/job.service';
import { ScoreChangeHistoryService } from '../../sync/services/score-change-history.service';
import { AutoUpdateProbeStateEntity } from '../schemas/auto-update-probe-state.schema';
import { AutoUpdateRunEntity } from '../schemas/auto-update-run.schema';
import { AutoUpdateTaskEntity } from '../schemas/auto-update-task.schema';
import { AutoUpdateSchedulerTimingService } from './auto-update-scheduler-timing.service';

const CHINA_OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const DAILY_TASK_TYPE = 'daily_full_update' as const;
const DAILY_JOB_SOURCE = 'auto_update_daily_full_update';
const DAILY_RUN_PREFIX = 'daily-full-update';
const TASK_STAGE_CHUNK_SIZE = 500;

export type DailyFullUpdateWindow = {
  businessDate: string;
  start: Date;
  end: Date;
};

export type DailyFullUpdateSummary = {
  businessDate: string | null;
  staged: number;
  reconciled: number;
  dispatched: number;
  activeUpdateScores: number;
  dispatchLimit: number;
};

export function dailyFullUpdateWindow(
  now: Date,
  triggerHour: number,
): DailyFullUpdateWindow | null {
  const chinaNow = new Date(now.getTime() + CHINA_OFFSET_MS);
  if (chinaNow.getUTCHours() < triggerHour) {
    return null;
  }
  const chinaTodayStartUtc =
    Date.UTC(
      chinaNow.getUTCFullYear(),
      chinaNow.getUTCMonth(),
      chinaNow.getUTCDate(),
    ) - CHINA_OFFSET_MS;
  const start = new Date(chinaTodayStartUtc - DAY_MS);
  const end = new Date(chinaTodayStartUtc);
  return {
    businessDate: new Date(start.getTime() + CHINA_OFFSET_MS)
      .toISOString()
      .slice(0, 10),
    start,
    end,
  };
}

@Injectable()
export class AutoUpdateDailyFullUpdateService {
  private readonly logger = new Logger(AutoUpdateDailyFullUpdateService.name);

  constructor(
    @InjectModel(AutoUpdateProbeStateEntity.name)
    private readonly stateModel: Model<AutoUpdateProbeStateEntity>,
    @InjectModel(AutoUpdateTaskEntity.name)
    private readonly taskModel: Model<AutoUpdateTaskEntity>,
    @InjectModel(AutoUpdateRunEntity.name)
    private readonly runsModel: Model<AutoUpdateRunEntity>,
    private readonly jobs: JobService,
    private readonly scoreChanges: ScoreChangeHistoryService,
    private readonly timing: AutoUpdateSchedulerTimingService,
    private readonly leases: RedisLeaseService,
  ) {}

  async run(now: Date, signal?: AbortSignal): Promise<DailyFullUpdateSummary> {
    const window = dailyFullUpdateWindow(now, this.timing.dailyFullUpdateHour);
    const staged = window
      ? await this.stageDailyTasksLeased(window, now, signal)
      : 0;
    signal?.throwIfAborted();
    const reconciled = await this.reconcileProcessingTasks(now, signal);
    signal?.throwIfAborted();
    const activeUpdateScores = await this.jobs.countActiveUpdateScores();
    const dispatchLimit =
      this.timing.dailyFullUpdateDispatchLimit(activeUpdateScores);
    const dispatched = dispatchLimit
      ? await this.dispatchQueuedTasks(now, dispatchLimit, signal)
      : 0;
    return {
      businessDate: window?.businessDate ?? null,
      staged,
      reconciled,
      dispatched,
      activeUpdateScores,
      dispatchLimit,
    };
  }

  private async stageDailyTasksLeased(
    window: DailyFullUpdateWindow,
    now: Date,
    outerSignal?: AbortSignal,
  ): Promise<number> {
    const name = `${DAILY_RUN_PREFIX}-trigger:${window.businessDate}`;
    const result = await this.leases.run(
      {
        name,
        ttlMs: this.timing.leaseTtlMs,
        renewEveryMs: this.timing.leaseRenewEveryMs,
        hardTimeoutMs: this.timing.sweepHardTimeoutMs,
        abortGraceMs: this.timing.sweepAbortGraceMs,
      },
      ({ signal }) => this.stageDailyTasks(window, now, outerSignal, signal),
    );
    return result.acquired ? result.value : 0;
  }

  private async stageDailyTasks(
    window: DailyFullUpdateWindow,
    now: Date,
    outerSignal?: AbortSignal,
    leaseSignal?: AbortSignal,
  ): Promise<number> {
    this.assertActive(outerSignal, leaseSignal);
    const bucketKey = `${DAILY_RUN_PREFIX}:${window.businessDate}`;
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
        if (this.isDuplicateKey(error)) {
          return 0;
        }
        throw error;
      }
    }

    const changedFriendCodes =
      await this.scoreChanges.distinctFriendCodesObservedBetween(
        window.start,
        window.end,
      );
    this.assertActive(outerSignal, leaseSignal);
    const states = changedFriendCodes.length
      ? await this.stateModel
          .find({
            enabled: true,
            friendCode: { $in: changedFriendCodes },
          })
          .select('friendCode cabinetUserId')
          .lean<AutoUpdateProbeStateEntity[]>()
          .exec()
      : [];

    for (
      let offset = 0;
      offset < states.length;
      offset += TASK_STAGE_CHUNK_SIZE
    ) {
      this.assertActive(outerSignal, leaseSignal);
      const chunk = states.slice(offset, offset + TASK_STAGE_CHUNK_SIZE);
      await this.taskModel.bulkWrite(
        chunk.map((state) => ({
          updateOne: {
            filter: { id: this.taskId(window.businessDate, state.friendCode) },
            update: {
              $setOnInsert: {
                id: this.taskId(window.businessDate, state.friendCode),
                type: DAILY_TASK_TYPE,
                friendCode: state.friendCode,
                cabinetUserId: state.cabinetUserId,
                status: 'queued',
                priority: 0,
                runAt: now,
                attempts: 0,
                lastError: null,
                metrics: {
                  businessDate: window.businessDate,
                  windowStart: window.start.toISOString(),
                  windowEnd: window.end.toISOString(),
                  jobId: null,
                  outcome: 'staged',
                },
                createdAt: now,
              },
            },
            upsert: true,
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
          totalUsers: states.length,
          triggered: states.length,
          skippedNoChange: Math.max(
            0,
            changedFriendCodes.length - states.length,
          ),
          failed: 0,
        },
      },
    );
    this.logger.log(
      `daily full update staged date=${window.businessDate} changed=${changedFriendCodes.length} eligible=${states.length}`,
    );
    return states.length;
  }

  private async reconcileProcessingTasks(
    now: Date,
    signal?: AbortSignal,
  ): Promise<number> {
    const tasks = await this.taskModel
      .find({ type: DAILY_TASK_TYPE, status: 'processing' })
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
    const trackedJobId = this.metricString(task, 'jobId');
    const tracked = trackedJobId
      ? await this.jobs.findById(trackedJobId)
      : null;
    const job = tracked ?? (await this.jobs.findLatestDailyFullUpdate(task.id));
    if (job) {
      return this.reconcileTrackedJob(task, job, now);
    }
    const claimAge = now.getTime() - new Date(task.updatedAt).getTime();
    if (claimAge < this.timing.dailyFullUpdateClaimTimeoutMs) {
      return false;
    }
    await this.requeueOrFail(task, now, 'stale daily dispatch claim');
    return true;
  }

  private async reconcileTrackedJob(
    task: AutoUpdateTaskEntity,
    job: JobResponse,
    now: Date,
  ): Promise<boolean> {
    if (job.status === 'completed') {
      await this.markTaskCompleted(task, job.id);
      return true;
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      await this.requeueOrFail(
        task,
        now,
        job.error ?? `tracked job ${job.status}`,
        job.id,
      );
      return true;
    }
    if (this.metricString(task, 'jobId') !== job.id) {
      await this.trackJob(task, job.id, 'recovered');
      return true;
    }
    return false;
  }

  private async dispatchQueuedTasks(
    now: Date,
    limit: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const tasks = await this.taskModel
      .find({
        type: DAILY_TASK_TYPE,
        status: 'queued',
        $or: [{ runAt: null }, { runAt: { $lte: now } }],
      })
      .sort({ runAt: 1, createdAt: 1 })
      .limit(limit)
      .lean<AutoUpdateTaskEntity[]>()
      .exec();
    let dispatched = 0;
    for (const task of tasks) {
      signal?.throwIfAborted();
      const claimed = await this.claimTask(task.id, now);
      if (!claimed) {
        continue;
      }
      await this.dispatchTask(claimed, now);
      dispatched++;
    }
    return dispatched;
  }

  private async claimTask(
    taskId: string,
    now: Date,
  ): Promise<AutoUpdateTaskEntity | null> {
    return this.taskModel
      .findOneAndUpdate(
        {
          id: taskId,
          type: DAILY_TASK_TYPE,
          status: 'queued',
          $or: [{ runAt: null }, { runAt: { $lte: now } }],
        },
        {
          $set: { status: 'processing', runAt: null, lastError: null },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .lean<AutoUpdateTaskEntity>()
      .exec();
  }

  private async dispatchTask(
    task: AutoUpdateTaskEntity,
    now: Date,
  ): Promise<void> {
    try {
      const recovered = await this.jobs.findLatestDailyFullUpdate(task.id);
      if (recovered && !['failed', 'canceled'].includes(recovered.status)) {
        await this.trackOrComplete(task, recovered, 'recovered');
        return;
      }
      const active = await this.jobs.getActiveFullUpdateScoreByFriendCode(
        task.friendCode,
      );
      if (active) {
        await this.trackOrComplete(task, active, 'covered_by_active');
        return;
      }
      const { jobId } = await this.jobs.create({
        friendCode: task.friendCode,
        jobType: 'update_score',
        source: 'auto_update',
        diffsToScrape: [...DXNET_ALL_DIFFICULTIES],
        // Daily candidates come from Rival-observed score changes. Achievement
        // and DX score are already current; this sweep only fills FC/FS across
        // every difficulty and therefore needs a single score type.
        fcfsOnly: true,
        cancelActiveJobs: false,
        context: {
          source: DAILY_JOB_SOURCE,
          dailyTaskId: task.id,
          businessDate: this.metricString(task, 'businessDate'),
          windowStart: this.metricString(task, 'windowStart'),
          windowEnd: this.metricString(task, 'windowEnd'),
        },
      });
      await this.trackJob(task, jobId, 'created');
    } catch (error) {
      await this.requeueOrFail(task, now, this.errorMessage(error));
    }
  }

  private async trackOrComplete(
    task: AutoUpdateTaskEntity,
    job: JobResponse,
    outcome: string,
  ): Promise<void> {
    if (job.status === 'completed') {
      await this.markTaskCompleted(task, job.id, outcome);
      return;
    }
    await this.trackJob(task, job.id, outcome);
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
          metrics: { ...(task.metrics ?? {}), jobId, outcome },
          lastError: null,
        },
      },
    );
  }

  private async markTaskCompleted(
    task: AutoUpdateTaskEntity,
    jobId: string,
    outcome = 'completed',
  ): Promise<void> {
    await this.taskModel.updateOne(
      { id: task.id, status: 'processing' },
      {
        $set: {
          status: 'completed',
          runAt: null,
          lastError: null,
          metrics: { ...(task.metrics ?? {}), jobId, outcome },
        },
      },
    );
  }

  private async requeueOrFail(
    task: AutoUpdateTaskEntity,
    now: Date,
    error: string,
    previousJobId?: string,
  ): Promise<void> {
    const terminal = task.attempts >= this.timing.dailyFullUpdateMaxAttempts;
    await this.taskModel.updateOne(
      { id: task.id, status: 'processing' },
      {
        $set: {
          status: terminal ? 'failed' : 'queued',
          runAt: terminal
            ? null
            : new Date(now.getTime() + this.timing.dailyFullUpdateRetryMs),
          lastError: error,
          metrics: {
            ...(task.metrics ?? {}),
            jobId: null,
            ...(previousJobId ? { previousJobId } : {}),
            outcome: terminal ? 'failed' : 'retry_scheduled',
          },
        },
      },
    );
  }

  private metricString(task: AutoUpdateTaskEntity, key: string): string | null {
    const value = task.metrics?.[key];
    return typeof value === 'string' ? value : null;
  }

  private taskId(businessDate: string, friendCode: string): string {
    return `${DAILY_RUN_PREFIX}:${businessDate}:${friendCode}`;
  }

  private assertActive(...signals: Array<AbortSignal | undefined>): void {
    for (const signal of signals) {
      signal?.throwIfAborted();
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return this.errorMessage(error).includes('E11000');
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
