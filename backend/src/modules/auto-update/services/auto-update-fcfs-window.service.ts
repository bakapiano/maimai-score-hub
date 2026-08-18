import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';

import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import { RedisService } from '../../../common/redis/redis.service';
import { JobService } from '../../job/services/job.service';
import { ScoreChangeHistoryService } from '../../sync/services/score-change-history.service';
import { AutoUpdateProbeStateEntity } from '../schemas/auto-update-probe-state.schema';
import { AutoUpdateRunEntity } from '../schemas/auto-update-run.schema';
import { AutoUpdateTaskEntity } from '../schemas/auto-update-task.schema';
import { AutoUpdateSchedulerTimingService } from './auto-update-scheduler-timing.service';

const HALF_HOUR_MS = 30 * 60_000;
const WINDOW_RUN_PREFIX = 'fcfs-score-window';
const PRODUCER_LIMIT_PER_MINUTE = 12;
const PRODUCER_BURST_PER_FIVE_SECONDS = 6;
const STAGE_CHUNK_SIZE = 500;

export type FcfsScoreWindow = { start: Date; end: Date; key: string };
export type FcfsWindowSummary = {
  windowKey: string;
  changedUsers: number;
  due: number;
  dispatched: number;
  deferred: number;
  failed: number;
};

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
export class AutoUpdateFcfsWindowService {
  private readonly logger = new Logger(AutoUpdateFcfsWindowService.name);

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
    private readonly redis: RedisService,
  ) {}

  async run(now: Date, signal?: AbortSignal): Promise<FcfsWindowSummary> {
    const window = latestClosedFcfsWindow(now);
    if (!this.timing.fcfsEnabled) {
      return {
        windowKey: window.key,
        changedUsers: 0,
        due: 0,
        dispatched: 0,
        deferred: 0,
        failed: 0,
      };
    }
    const changedUsers = await this.stageWindowLeased(window, now, signal);
    signal?.throwIfAborted();
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
      .limit(this.timing.mapBatchLimit)
      .lean<AutoUpdateProbeStateEntity[]>()
      .exec();
    const results = await this.dispatchStates(states, now, signal);
    return {
      windowKey: window.key,
      changedUsers,
      due: states.length,
      dispatched: results.filter((result) => result === 'dispatched').length,
      deferred: results.filter((result) => result === 'deferred').length,
      failed: results.filter((result) => result === 'failed').length,
    };
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
    signal?: AbortSignal,
  ): Promise<Array<'dispatched' | 'deferred' | 'failed'>> {
    const results: Array<'dispatched' | 'deferred' | 'failed'> = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.mapConcurrency, states.length) },
      async () => {
        while (next < states.length) {
          signal?.throwIfAborted();
          const index = next++;
          results[index] = await this.dispatchState(states[index], now);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async dispatchState(
    state: AutoUpdateProbeStateEntity,
    now: Date,
  ): Promise<'dispatched' | 'deferred' | 'failed'> {
    const musicIds = [...new Set(state.pendingFcfsMusicIds ?? [])];
    if (!musicIds.length) {
      return 'deferred';
    }
    if (await this.jobs.getActiveUpdateScoreByFriendCode(state.friendCode)) {
      return 'deferred';
    }
    if (!(await this.acquireProducerSlot(now))) {
      return 'deferred';
    }

    const taskId = randomUUID();
    await this.taskModel.create({
      id: taskId,
      type: 'fcfs_enrichment',
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: 0,
      runAt: now,
      attempts: 1,
      lastError: null,
      metrics: {
        source: 'score_change_window',
        musicIds,
        windowStart: state.pendingFcfsWindowStart?.toISOString() ?? null,
        windowEnd: state.pendingFcfsWindowEnd?.toISOString() ?? null,
      },
    });
    try {
      const created = await this.jobs.create({
        friendCode: state.friendCode,
        jobType: 'update_score',
        source: 'auto_update',
        musicIds,
        fcfsOnly: true,
        cancelActiveJobs: false,
        context: {
          source: 'auto_update_fcfs_score_window',
          autoUpdateFcfs: true,
          fcfsTaskId: taskId,
          windowStart: state.pendingFcfsWindowStart?.toISOString() ?? null,
          windowEnd: state.pendingFcfsWindowEnd?.toISOString() ?? null,
        },
      });
      await Promise.all([
        this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              lastFcfsUpdateAt: now,
              nextFcfsUpdateAt: new Date(
                now.getTime() + this.timing.fcfsCooldownMs,
              ),
              pendingFcfsMusicIds: [],
              pendingFcfsWindowStart: null,
              pendingFcfsWindowEnd: null,
              pendingFcfsRequestedAt: null,
              pendingFcfsCount: 0,
              fcfsErrorCount: 0,
            },
          },
        ),
        this.taskModel.updateOne(
          { id: taskId },
          {
            $set: {
              status: 'completed',
              metrics: {
                source: 'score_change_window',
                musicIds,
                dxnetJobId: created.jobId,
              },
            },
          },
        ),
      ]);
      return 'dispatched';
    } catch (error) {
      const failureCount = (state.fcfsErrorCount ?? 0) + 1;
      const message = this.errorMessage(error);
      await Promise.all([
        this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              fcfsErrorCount: failureCount,
              nextFcfsUpdateAt: new Date(
                now.getTime() + this.timing.fcfsRetryDelayMs(failureCount),
              ),
            },
          },
        ),
        this.taskModel.updateOne(
          { id: taskId },
          { $set: { status: 'failed', lastError: message } },
        ),
      ]);
      this.logger.warn(
        `failed to dispatch targeted FC/FS update fc=${state.friendCode}: ${message}`,
      );
      return 'failed';
    }
  }

  private async acquireProducerSlot(now: Date): Promise<boolean> {
    const minute = now.toISOString().slice(0, 16);
    const burst = Math.floor(now.getTime() / 5_000);
    const burstCount = await this.redis.incrementWithExpiry(
      this.redis.key(`dxnet:auto-fcfs:burst:${burst}`),
      10,
    );
    if (burstCount > PRODUCER_BURST_PER_FIVE_SECONDS) {
      return false;
    }
    const minuteCount = await this.redis.incrementWithExpiry(
      this.redis.key(`dxnet:auto-fcfs:minute:${minute}`),
      120,
    );
    return minuteCount <= PRODUCER_LIMIT_PER_MINUTE;
  }

  private assertActive(...signals: Array<AbortSignal | undefined>): void {
    for (const signal of signals) {
      signal?.throwIfAborted();
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
