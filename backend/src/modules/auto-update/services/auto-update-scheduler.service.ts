/* eslint-disable max-lines */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { CronJob } from 'cron';
import type { Model } from 'mongoose';
import { DXNET_ALL_DIFFICULTIES } from '@maimai-score-hub/shared';

import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import type { JobResponse } from '../../job/job.types';
import { JobService } from '../../job/services/job.service';
import { ProberExportService } from '../../prober-export/services/prober-export.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { SyncService } from '../../sync/services/sync.service';
import { UsersService } from '../../users/services/users.service';
import {
  AutoUpdateProbeStateEntity,
  type AutoUpdateTier,
} from '../schemas/auto-update-probe-state.schema';
import { AutoUpdateRunEntity } from '../schemas/auto-update-run.schema';
import { AutoUpdateTaskEntity } from '../schemas/auto-update-task.schema';
import {
  AutoUpdateSchedulerTimingService,
  countRivalDetails,
} from './auto-update-scheduler-timing.service';
import { AutoUpdateActivityService } from './auto-update-activity.service';
import { AutoUpdateDailyFullUpdateService } from './auto-update-daily-full-update.service';
import { AutoUpdateFcfsWindowService } from './auto-update-fcfs-window.service';

const SCHEDULER_VERSION = 'rival-first-v1';
const SETTLED_FULL_UPDATE_SOURCE = 'auto_update_settled_full_update';
const SETTLED_FULL_UPDATE_TASK_TYPE = 'settled_full_update' as const;

type AutoUpdateProbeResult = {
  friendCode: string;
  cabinetUserId: number;
  action: 'triggered' | 'skipped' | 'failed';
  message?: string;
};
type RivalMusic = Awaited<
  ReturnType<SdgbJobDispatcher['getRivalHash']>
>['music'];
type PendingFullUpdateSummary = {
  due: number;
  created: number;
  coveredByActive: number;
  deferred: number;
  failed: number;
};

function coversAllDifficulties(job: JobResponse): boolean {
  if (job.musicIds?.length) {
    return false;
  }
  if (!job.diffsToScrape?.length) {
    return true;
  }
  return DXNET_ALL_DIFFICULTIES.every((diff) =>
    job.diffsToScrape?.includes(diff),
  );
}

@Injectable()
export class AutoUpdateSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AutoUpdateSchedulerService.name);
  private cron: CronJob | null = null;
  private running = false;

  constructor(
    private readonly users: UsersService,
    private readonly jobs: JobService,
    private readonly botStatus: BotStatusService,
    private readonly sdgb: SdgbJobDispatcher,
    private readonly syncService: SyncService,
    private readonly proberExports: ProberExportService,
    @InjectModel(AutoUpdateProbeStateEntity.name)
    private readonly stateModel: Model<AutoUpdateProbeStateEntity>,
    @InjectModel(AutoUpdateTaskEntity.name)
    private readonly taskModel: Model<AutoUpdateTaskEntity>,
    @InjectModel(AutoUpdateRunEntity.name)
    private readonly runsModel: Model<AutoUpdateRunEntity>,
    private readonly timing: AutoUpdateSchedulerTimingService,
    private readonly activity: AutoUpdateActivityService,
    private readonly fcfsWindow: AutoUpdateFcfsWindowService,
    private readonly dailyFullUpdate: AutoUpdateDailyFullUpdateService,
    private readonly leases: RedisLeaseService,
  ) {}

  onModuleInit() {
    this.cron = new CronJob(
      this.timing.cronExpr,
      () => {
        this.runSweepLeased().catch((err) =>
          this.logger.error('Auto-update cron sweep failed', err),
        );
      },
      null,
      true,
    );
    this.logger.log(
      `Rival-first auto-update scheduler started (cron=${this.timing.cronExpr})`,
    );
  }

  onModuleDestroy() {
    this.cron?.stop();
    this.cron = null;
  }

  private currentBucketKey(): string {
    const last = this.cron?.lastDate();
    const ref = last instanceof Date ? last : new Date();
    return ref.toISOString().slice(0, 16);
  }

  private async runSweepLeased(): Promise<void> {
    const result = await this.leases.run(
      {
        name: 'auto-update-sweep',
        ttlMs: this.timing.leaseTtlMs,
        renewEveryMs: this.timing.leaseRenewEveryMs,
        hardTimeoutMs: this.timing.sweepHardTimeoutMs,
        abortGraceMs: this.timing.sweepAbortGraceMs,
      },
      ({ signal }) => this.runSweepClaimed(signal),
    );
    if (!result.acquired) {
      this.logger.debug(
        'Skipping auto-update sweep: another replica owns the lease',
      );
    }
  }

  private async runSweepClaimed(
    signal?: AbortSignal,
  ): Promise<Awaited<
    ReturnType<AutoUpdateSchedulerService['runSweep']>
  > | null> {
    signal?.throwIfAborted();
    const bucketKey = this.currentBucketKey();
    let won = false;
    try {
      const previous = await this.runsModel.findOneAndUpdate(
        { bucketKey },
        {
          $setOnInsert: {
            bucketKey,
            triggeredAt: new Date(),
            ranOn: process.env.HOSTNAME || 'unknown',
            status: 'running',
            totalUsers: 0,
            triggered: 0,
            skippedNoChange: 0,
            failed: 0,
          },
        },
        { upsert: true, returnDocument: 'before' },
      );
      won = previous === null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('E11000')) {
        won = false;
      } else {
        throw err;
      }
    }

    if (!won) {
      return null;
    }

    signal?.throwIfAborted();
    const summary = await this.runSweep(signal);
    await this.runsModel
      .updateOne(
        { bucketKey },
        {
          $set: {
            status: 'completed',
            totalUsers: summary.totalUsers,
            triggered: summary.triggered,
            skippedNoChange: summary.skippedNoChange,
            failed: summary.failed,
          },
        },
      )
      .catch((err) =>
        this.logger.warn(`failed to finalize auto-update run row: ${err}`),
      );
    return summary;
  }

  // Rival, map, FC/FS, settled and daily lanes intentionally share one leased
  // snapshot so all due calculations use the same `now`.
  // eslint-disable-next-line complexity
  async runSweep(signal?: AbortSignal): Promise<{
    totalUsers: number;
    triggered: number;
    skippedNoChange: number;
    failed: number;
    entries: Array<{
      friendCode: string;
      cabinetUserId: number;
      action: 'triggered' | 'skipped' | 'failed';
      message?: string;
    }>;
  }> {
    if (this.running) {
      this.logger.warn('Auto-update sweep already running, skipping tick');
      return {
        totalUsers: 0,
        triggered: 0,
        skippedNoChange: 0,
        failed: 0,
        entries: [],
      };
    }

    this.running = true;
    try {
      signal?.throwIfAborted();
      const now = new Date();
      await this.syncEnabledStates(now, signal);
      signal?.throwIfAborted();
      const due = await this.stateModel
        .find({
          enabled: true,
          nextRivalProbeAt: { $lte: now },
          $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
        })
        .sort({ nextRivalProbeAt: 1 })
        .limit(this.timing.rivalBatchLimit)
        .lean<AutoUpdateProbeStateEntity[]>()
        .exec();

      const results = await this.runDueStates(due, signal);
      signal?.throwIfAborted();
      const mapDue = await this.stateModel
        .find({
          enabled: true,
          nextMapProbeAt: { $lte: now },
          $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
        })
        .sort({ nextMapProbeAt: 1 })
        .limit(this.timing.mapBatchLimit)
        .lean<AutoUpdateProbeStateEntity[]>()
        .exec();
      const mapResults = await this.runDueMapStates(mapDue, signal);
      signal?.throwIfAborted();
      const fcfsWindow = await this.fcfsWindow.run(now, signal).catch((err) => {
        this.logger.warn(
          `targeted FC/FS sweep failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return null;
      });
      signal?.throwIfAborted();
      const pendingFullReconciled = await this.reconcileSettledFullUpdateTasks(
        now,
        signal,
      );
      signal?.throwIfAborted();
      const pendingFullActive = await this.jobs.countActiveUpdateScoreBySource(
        SETTLED_FULL_UPDATE_SOURCE,
      );
      const pendingFullDispatchLimit =
        this.timing.settledFullUpdateDispatchLimit(pendingFullActive);
      const pendingFullUpdateDue = pendingFullDispatchLimit
        ? await this.stateModel
            .find({
              enabled: true,
              pendingFullUpdateAt: { $lte: now },
              $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
            })
            .sort({ pendingFullUpdateAt: 1 })
            .limit(pendingFullDispatchLimit)
            .lean<AutoUpdateProbeStateEntity[]>()
            .exec()
        : [];
      const pendingFullUpdate = await this.runDuePendingFullUpdateStates(
        pendingFullUpdateDue,
        now,
        signal,
      );
      const dailyFullUpdate = await this.dailyFullUpdate
        .run(now, signal)
        .catch((err) => {
          this.logger.warn(
            `daily full update sweep failed: ${
              err instanceof Error ? err.message : err
            }`,
          );
          return null;
        });

      const triggered = results.filter((r) => r.action === 'triggered').length;
      const skippedNoChange =
        results.filter((r) => r.action === 'skipped').length +
        mapResults.filter((r) => r.action === 'skipped').length;
      const failed =
        results.filter((r) => r.action === 'failed').length +
        mapResults.filter((r) => r.action === 'failed').length;

      this.logger.log(
        `rival-first auto-update sweep done: ${triggered} changed, ${skippedNoChange} unchanged, ${failed} failed (rivalDue=${due.length}, mapDue=${mapDue.length}, fcfsWindow=${fcfsWindow?.windowKey ?? '-'}, fcfsChangedUsers=${fcfsWindow?.changedUsers ?? 0}, pendingFullReconciled=${pendingFullReconciled}, pendingFullActive=${pendingFullActive}, pendingFullLimit=${pendingFullDispatchLimit}, pendingFullDue=${pendingFullUpdate.due}, pendingFullCreated=${pendingFullUpdate.created}, pendingFullCovered=${pendingFullUpdate.coveredByActive}, pendingFullDeferred=${pendingFullUpdate.deferred}, pendingFullFailed=${pendingFullUpdate.failed}, dailyDate=${dailyFullUpdate?.businessDate ?? '-'}, dailyStaged=${dailyFullUpdate?.staged ?? 0}, dailyReconciled=${dailyFullUpdate?.reconciled ?? 0}, dailyDispatched=${dailyFullUpdate?.dispatched ?? 0}, dailyActive=${dailyFullUpdate?.activeUpdateScores ?? 0}, dailyLimit=${dailyFullUpdate?.dispatchLimit ?? 0})`,
      );

      return {
        totalUsers: due.length + mapDue.length,
        triggered,
        skippedNoChange,
        failed,
        entries: [...results, ...mapResults],
      };
    } finally {
      this.running = false;
    }
  }

  private async syncEnabledStates(
    now: Date,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const users = await this.users.getAutoUpdateUsers();
    const activeFriendCodes = users.map((u) => u.friendCode);
    if (users.length) {
      signal?.throwIfAborted();
      await this.stateModel.bulkWrite(
        users.map((u) => {
          const initialDue = this.timing.initialRivalProbeAt(u.friendCode, now);
          const initialMapDue = this.timing.initialMapProbeAt(
            u.friendCode,
            now,
          );
          return {
            updateOne: {
              filter: { friendCode: u.friendCode },
              update: {
                $set: {
                  cabinetUserId: u.cabinetUserId!,
                  enabled: true,
                  schedulerVersion: SCHEDULER_VERSION,
                },
                $setOnInsert: {
                  tier: 'cold',
                  lastRivalHash: null,
                  nextRivalProbeAt: initialDue,
                  nextMapProbeAt: initialMapDue,
                  habitMultiplier: 1,
                  loadMultiplier: 1,
                  rivalErrorCount: 0,
                  mapErrorCount: 0,
                  lastAutoUpdateActivityAt: null,
                  pendingFullUpdateAt: null,
                  lastFcfsUpdateAt: null,
                  nextFcfsUpdateAt: null,
                  pendingFcfsMusicIds: [],
                  pendingFcfsWindowStart: null,
                  pendingFcfsWindowEnd: null,
                  pendingFcfsRequestedAt: null,
                  pendingFcfsCount: 0,
                  fcfsErrorCount: 0,
                  backoffUntil: null,
                },
              },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
    }

    signal?.throwIfAborted();
    await this.stateModel.updateMany(
      activeFriendCodes.length
        ? { friendCode: { $nin: activeFriendCodes }, enabled: true }
        : { enabled: true },
      { $set: { enabled: false } },
    );
  }

  private async runDueStates(
    states: AutoUpdateProbeStateEntity[],
    signal?: AbortSignal,
  ): Promise<AutoUpdateProbeResult[]> {
    const results: AutoUpdateProbeResult[] = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.concurrency, states.length) },
      async () => {
        while (next < states.length) {
          signal?.throwIfAborted();
          const index = next++;
          results[index] = await this.processRivalProbe(states[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async runDueMapStates(
    states: AutoUpdateProbeStateEntity[],
    signal?: AbortSignal,
  ): Promise<AutoUpdateProbeResult[]> {
    const results: AutoUpdateProbeResult[] = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.mapConcurrency, states.length) },
      async () => {
        while (next < states.length) {
          signal?.throwIfAborted();
          const index = next++;
          results[index] = await this.processMapProbe(states[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async runDuePendingFullUpdateStates(
    states: AutoUpdateProbeStateEntity[],
    now: Date,
    signal?: AbortSignal,
  ): Promise<PendingFullUpdateSummary> {
    const results: Array<
      'created' | 'coveredByActive' | 'deferred' | 'failed'
    > = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.mapConcurrency, states.length) },
      async () => {
        while (next < states.length) {
          signal?.throwIfAborted();
          const index = next++;
          results[index] = await this.processPendingFullUpdate(
            states[index],
            now,
          );
        }
      },
    );
    await Promise.all(workers);
    return {
      due: states.length,
      created: results.filter((r) => r === 'created').length,
      coveredByActive: results.filter((r) => r === 'coveredByActive').length,
      deferred: results.filter((r) => r === 'deferred').length,
      failed: results.filter((r) => r === 'failed').length,
    };
  }

  private async processPendingFullUpdate(
    state: AutoUpdateProbeStateEntity,
    now: Date,
  ): Promise<'created' | 'coveredByActive' | 'deferred' | 'failed'> {
    const active = await this.jobs.getActiveUpdateScoreByFriendCode(
      state.friendCode,
    );
    if (active && !coversAllDifficulties(active)) {
      return 'deferred';
    }
    const taskId = randomUUID();
    const metrics = {
      source: 'settled_activity',
      pendingFullUpdateAt: state.pendingFullUpdateAt?.toISOString() ?? null,
      lastActivityAt: state.lastAutoUpdateActivityAt?.toISOString() ?? null,
      outcome: 'claiming',
    };
    const taskSnapshot = {
      id: taskId,
      type: SETTLED_FULL_UPDATE_TASK_TYPE,
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: 0,
      runAt: now,
      attempts: 1,
      lastError: null,
      metrics,
      createdAt: now,
      updatedAt: now,
    } as AutoUpdateTaskEntity;
    await this.taskModel.create(taskSnapshot);
    try {
      if (active) {
        await Promise.all([
          this.trackSettledFullUpdateJob(
            taskSnapshot,
            active.id,
            'covered_by_active',
          ),
          this.clearPendingFullUpdate(
            state.friendCode,
            state.pendingFullUpdateAt,
          ),
        ]);
        return 'coveredByActive';
      }

      const created = await this.jobs.create({
        friendCode: state.friendCode,
        jobType: 'update_score',
        source: 'auto_update',
        diffsToScrape: [...DXNET_ALL_DIFFICULTIES],
        // Rival probes already persist achievement and DX score. The settled
        // sweep only closes whole-catalog FC/FS gaps, so one score type halves
        // DX NET page work and reduces background hard-timeout pressure.
        fcfsOnly: true,
        cancelActiveJobs: false,
        context: {
          source: SETTLED_FULL_UPDATE_SOURCE,
          settledTaskId: taskId,
          lastActivityAt: state.lastAutoUpdateActivityAt?.toISOString() ?? null,
        },
      });
      await Promise.all([
        this.trackSettledFullUpdateJob(taskSnapshot, created.jobId, 'created'),
        this.clearPendingFullUpdate(
          state.friendCode,
          state.pendingFullUpdateAt,
        ),
      ]);
      return 'created';
    } catch (err) {
      await this.failSettledFullUpdateTask(
        taskSnapshot,
        now,
        err instanceof Error ? err.message : String(err),
      );
      this.logger.warn(
        `failed to create settled full update fc=${state.friendCode}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return 'failed';
    }
  }

  private async clearPendingFullUpdate(
    friendCode: string,
    pendingAt?: Date | null,
  ): Promise<void> {
    const filter: Record<string, unknown> = { friendCode };
    if (pendingAt) {
      filter.pendingFullUpdateAt = pendingAt;
    }
    await this.stateModel.updateOne(filter, {
      $set: {
        pendingFullUpdateAt: null,
        schedulerVersion: SCHEDULER_VERSION,
      },
    });
  }

  private async reconcileSettledFullUpdateTasks(
    now: Date,
    signal?: AbortSignal,
  ): Promise<number> {
    const tasks = await this.taskModel
      .find({ type: SETTLED_FULL_UPDATE_TASK_TYPE, status: 'processing' })
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean<AutoUpdateTaskEntity[]>()
      .exec();
    let reconciled = 0;
    for (const task of tasks) {
      signal?.throwIfAborted();
      if (await this.reconcileSettledFullUpdateTask(task, now)) {
        reconciled++;
      }
    }
    return reconciled;
  }

  private async reconcileSettledFullUpdateTask(
    task: AutoUpdateTaskEntity,
    now: Date,
  ): Promise<boolean> {
    const trackedJobId = this.taskMetricString(task, 'jobId');
    const tracked = trackedJobId
      ? await this.jobs.findById(trackedJobId)
      : null;
    const job =
      tracked ?? (await this.jobs.findLatestSettledFullUpdate(task.id));
    if (job) {
      return this.reconcileSettledTrackedJob(task, job, now);
    }
    const updatedAt = new Date(task.updatedAt ?? task.createdAt ?? now);
    if (
      now.getTime() - updatedAt.getTime() <
      this.timing.settledFullUpdateClaimTimeoutMs
    ) {
      return false;
    }
    await this.failSettledFullUpdateTask(
      task,
      now,
      'stale settled full-update dispatch claim',
    );
    return true;
  }

  private async reconcileSettledTrackedJob(
    task: AutoUpdateTaskEntity,
    job: JobResponse,
    now: Date,
  ): Promise<boolean> {
    if (job.status === 'completed') {
      await this.taskModel.updateOne(
        { id: task.id, status: 'processing' },
        {
          $set: {
            status: 'completed',
            runAt: null,
            lastError: null,
            metrics: {
              ...(task.metrics ?? {}),
              jobId: job.id,
              outcome: 'completed',
            },
          },
        },
      );
      return true;
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      await this.failSettledFullUpdateTask(
        task,
        now,
        job.error ?? `tracked job ${job.status}`,
        job.id,
      );
      return true;
    }
    if (this.taskMetricString(task, 'jobId') !== job.id) {
      await this.trackSettledFullUpdateJob(task, job.id, 'recovered');
      return true;
    }
    return false;
  }

  private async trackSettledFullUpdateJob(
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

  private async failSettledFullUpdateTask(
    task: AutoUpdateTaskEntity,
    now: Date,
    error: string,
    previousJobId?: string,
  ): Promise<void> {
    const retryAt = new Date(
      now.getTime() + this.timing.settledFullUpdateRetryMs,
    );
    await Promise.all([
      this.stateModel.updateOne(
        {
          friendCode: task.friendCode,
          $or: [
            { pendingFullUpdateAt: null },
            { pendingFullUpdateAt: { $exists: false } },
            { pendingFullUpdateAt: { $gt: retryAt } },
          ],
        },
        {
          $set: {
            pendingFullUpdateAt: retryAt,
            schedulerVersion: SCHEDULER_VERSION,
          },
        },
      ),
      this.taskModel.updateOne(
        { id: task.id, status: 'processing' },
        {
          $set: {
            status: 'failed',
            runAt: null,
            lastError: error,
            metrics: {
              ...(task.metrics ?? {}),
              jobId: null,
              ...(previousJobId ? { previousJobId } : {}),
              outcome: 'retry_scheduled',
            },
          },
        },
      ),
    ]);
  }

  private taskMetricString(
    task: AutoUpdateTaskEntity,
    key: string,
  ): string | null {
    const value = task.metrics?.[key];
    return typeof value === 'string' ? value : null;
  }

  private async processRivalProbe(
    state: AutoUpdateProbeStateEntity,
  ): Promise<AutoUpdateProbeResult> {
    const taskId = randomUUID();
    const startedAt = Date.now();
    await this.createRivalTask(taskId, state);

    try {
      const { hash, music } = await this.sdgb.getRivalHash(
        { cabinetUserId: state.cabinetUserId },
        {
          tag: `auto-rival:${state.friendCode}`,
          timeoutMs: this.timing.rivalTimeoutMs,
        },
      );
      const now = new Date();
      const durationMs = Date.now() - startedAt;
      const hashChanged = hash !== state.lastRivalHash;
      const musicCount = music.length;
      const detailCount = countRivalDetails(music);

      if (hashChanged) {
        return await this.completeChangedRivalProbe({
          state,
          taskId,
          now,
          durationMs,
          musicCount,
          detailCount,
          hash,
          music,
        });
      }

      return await this.completeUnchangedRivalProbe({
        state,
        taskId,
        now,
        durationMs,
        musicCount,
        detailCount,
      });
    } catch (err) {
      return await this.failRivalProbe(state, taskId, startedAt, err);
    }
  }

  private async createRivalTask(
    taskId: string,
    state: AutoUpdateProbeStateEntity,
  ): Promise<void> {
    await this.taskModel.create({
      id: taskId,
      type: 'rival_score_probe',
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: this.timing.priorityForTier(state.tier),
      runAt: new Date(),
      attempts: 1,
      lastError: null,
      metrics: null,
    });
  }

  private async completeChangedRivalProbe(input: {
    state: AutoUpdateProbeStateEntity;
    taskId: string;
    now: Date;
    durationMs: number;
    musicCount: number;
    detailCount: number;
    hash: string;
    music: RivalMusic;
  }): Promise<AutoUpdateProbeResult> {
    const {
      state,
      taskId,
      now,
      durationMs,
      musicCount,
      detailCount,
      hash,
      music,
    } = input;
    const sync = await this.syncService.createFromRivalMusic({
      friendCode: state.friendCode,
      sourceId: taskId,
      music,
    });
    if (!sync) {
      throw new Error('rival music returned no mappable scores');
    }
    if (sync.changedChartCount > 0) {
      this.enqueueRivalAutoExport(state.friendCode);
    }
    await this.stateModel.updateOne(
      { friendCode: state.friendCode },
      {
        $set: {
          tier: 'hot',
          lastRivalHash: hash,
          lastRivalProbeAt: now,
          lastScoreChangedAt: now,
          nextRivalProbeAt: this.timing.nextProbeAt('hot', now, state),
          rivalErrorCount: 0,
          backoffUntil: null,
          schedulerVersion: SCHEDULER_VERSION,
        },
      },
    );
    await this.completeTask(taskId, {
      durationMs,
      hashChanged: true,
      musicCount,
      detailCount,
      scoreCount: Array.isArray(sync.scores) ? sync.scores.length : null,
    });
    await this.activity.recordActivitySignal({
      friendCode: state.friendCode,
      at: now,
    });
    return {
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      action: 'triggered',
      message: `hash changed, merged ${Array.isArray(sync.scores) ? sync.scores.length : '?'} scores`,
    };
  }

  private enqueueRivalAutoExport(friendCode: string): void {
    this.proberExports
      .ensureAutoExportWake(friendCode)
      .catch((err) =>
        this.logger.warn(
          `failed to enqueue rival auto-export fc=${friendCode}: ${
            err instanceof Error ? err.message : err
          }`,
        ),
      );
  }

  private async completeUnchangedRivalProbe(input: {
    state: AutoUpdateProbeStateEntity;
    taskId: string;
    now: Date;
    durationMs: number;
    musicCount: number;
    detailCount: number;
  }): Promise<AutoUpdateProbeResult> {
    const { state, taskId, now, durationMs, musicCount, detailCount } = input;
    const nextTier = this.timing.decayTier(state, now);
    await this.stateModel.updateOne(
      { friendCode: state.friendCode },
      {
        $set: {
          tier: nextTier,
          lastRivalProbeAt: now,
          nextRivalProbeAt: this.timing.nextProbeAt(nextTier, now, state),
          rivalErrorCount: 0,
          backoffUntil: null,
          schedulerVersion: SCHEDULER_VERSION,
        },
      },
    );
    await this.completeTask(taskId, {
      durationMs,
      hashChanged: false,
      musicCount,
      detailCount,
    });
    return {
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      action: 'skipped',
      message: 'hash unchanged',
    };
  }

  private async failRivalProbe(
    state: AutoUpdateProbeStateEntity,
    taskId: string,
    startedAt: number,
    err: unknown,
  ): Promise<AutoUpdateProbeResult> {
    const now = new Date();
    const msg = err instanceof Error ? err.message : String(err);
    const failureCount = (state.rivalErrorCount ?? 0) + 1;
    const backoffUntil = new Date(
      now.getTime() + this.timing.rivalBackoffDelayMs(failureCount),
    );
    await Promise.all([
      this.stateModel.updateOne(
        { friendCode: state.friendCode },
        {
          $set: {
            rivalErrorCount: failureCount,
            backoffUntil,
            nextRivalProbeAt: backoffUntil,
            lastRivalProbeAt: now,
            schedulerVersion: SCHEDULER_VERSION,
          },
        },
      ),
      this.taskModel.updateOne(
        { id: taskId },
        {
          $set: {
            status: 'failed',
            lastError: msg,
            updatedAt: now,
            metrics: { durationMs: Date.now() - startedAt },
          },
        },
      ),
    ]);
    this.logger.warn(
      `rival-first auto-update failed fc=${state.friendCode}: ${msg}`,
    );
    return {
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      action: 'failed',
      message: msg,
    };
  }

  private async completeTask(
    taskId: string,
    metrics: Record<string, unknown>,
  ): Promise<void> {
    await this.taskModel.updateOne(
      { id: taskId },
      {
        $set: {
          status: 'completed',
          metrics,
          lastError: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  private async processMapProbe(state: AutoUpdateProbeStateEntity): Promise<{
    friendCode: string;
    cabinetUserId: number;
    action: 'triggered' | 'skipped' | 'failed';
    message?: string;
  }> {
    const taskId = randomUUID();
    const startedAt = Date.now();
    await this.taskModel.create({
      id: taskId,
      type: 'map_auxiliary_probe',
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: this.timing.priorityForTier(state.tier),
      runAt: new Date(),
      attempts: 1,
      lastError: null,
      metrics: null,
    });

    try {
      const { maps } = await this.sdgb.getUserMap(
        { cabinetUserId: state.cabinetUserId },
        {
          tag: `auto-map:${state.friendCode}`,
          timeoutMs: this.timing.mapTimeoutMs,
        },
      );
      const now = new Date();
      const fingerprint = this.timing.mapFingerprint(maps);
      const changed =
        state.mapFingerprint !== null &&
        state.mapFingerprint !== undefined &&
        state.mapFingerprint !== fingerprint.mapFingerprint;
      const nextTier: AutoUpdateTier = changed
        ? 'hot'
        : this.timing.decayTier(state, now);
      const set: Record<string, unknown> = {
        tier: nextTier,
        mapFingerprint: fingerprint.mapFingerprint,
        mapDistanceSum: fingerprint.mapDistanceSum,
        lastMapProbeAt: now,
        nextMapProbeAt: this.timing.nextMapProbeAt(nextTier, now, state),
        mapErrorCount: 0,
        backoffUntil: null,
        schedulerVersion: SCHEDULER_VERSION,
      };

      if (changed) {
        set.lastMapDeltaAt = now;
        if (this.timing.shouldProbeRivalNow(state, now)) {
          set.nextRivalProbeAt = now;
        }
      }

      await this.stateModel.updateOne(
        { friendCode: state.friendCode },
        { $set: set },
      );
      await this.completeTask(taskId, {
        durationMs: Date.now() - startedAt,
        changed,
        rowCount: fingerprint.rowCount,
        mapDistanceSum: fingerprint.mapDistanceSum,
      });

      if (changed) {
        await this.activity.recordActivitySignal({
          friendCode: state.friendCode,
          at: now,
        });
      }

      return {
        friendCode: state.friendCode,
        cabinetUserId: state.cabinetUserId,
        action: 'skipped',
        message: changed ? 'map changed' : 'map unchanged',
      };
    } catch (err) {
      const now = new Date();
      const msg = err instanceof Error ? err.message : String(err);
      const failureCount = (state.mapErrorCount ?? 0) + 1;
      const backoffUntil = new Date(
        now.getTime() + this.timing.mapBackoffDelayMs(failureCount),
      );
      await Promise.all([
        this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              mapErrorCount: failureCount,
              nextMapProbeAt: backoffUntil,
              schedulerVersion: SCHEDULER_VERSION,
            },
          },
        ),
        this.taskModel.updateOne(
          { id: taskId },
          {
            $set: {
              status: 'failed',
              lastError: msg,
              updatedAt: now,
              metrics: { durationMs: Date.now() - startedAt },
            },
          },
        ),
      ]);
      return {
        friendCode: state.friendCode,
        cabinetUserId: state.cabinetUserId,
        action: 'failed',
        message: msg,
      };
    }
  }
}
