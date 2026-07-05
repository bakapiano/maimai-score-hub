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

import { BotStatusService } from '../../bots/services/bot-status.service';
import { JobService } from '../../job/services/job.service';
import { ProberExportService } from '../../prober-export/services/prober-export.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { SyncService } from '../../sync/services/sync.service';
import { UsersService } from '../../users/services/users.service';
import {
  AutoUpdateProbeStateEntity,
  type AutoUpdateFcfsReason,
  type AutoUpdateTier,
} from '../schemas/auto-update-probe-state.schema';
import { AutoUpdateRunEntity } from '../schemas/auto-update-run.schema';
import { AutoUpdateTaskEntity } from '../schemas/auto-update-task.schema';
import {
  AutoUpdateSchedulerTimingService,
  countRivalDetails,
} from './auto-update-scheduler-timing.service';
import { AutoUpdateActivityService } from './auto-update-activity.service';

const SCHEDULER_VERSION = 'rival-first-v1';
const FCFS_REASONS: AutoUpdateFcfsReason[] = [
  'rival_hash_changed',
  'map_delta',
  'manual',
];
const FCFS_REASON_PRIORITY: Record<AutoUpdateFcfsReason, number> = {
  map_delta: 1,
  rival_hash_changed: 2,
  manual: 3,
};

type AutoUpdateProbeResult = {
  friendCode: string;
  cabinetUserId: number;
  action: 'triggered' | 'skipped' | 'failed';
  message?: string;
};
type RivalMusic = Awaited<
  ReturnType<SdgbJobDispatcher['getRivalHash']>
>['music'];
type PendingFcfsSummary = {
  due: number;
  triggered: number;
  failed: number;
};
type PendingFullUpdateSummary = {
  due: number;
  created: number;
  coveredByActive: number;
  failed: number;
};

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
  ) {}

  onModuleInit() {
    this.cron = new CronJob(
      this.timing.cronExpr,
      () => {
        this.runSweepClaimed().catch((err) =>
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

  private async runSweepClaimed(): Promise<Awaited<
    ReturnType<AutoUpdateSchedulerService['runSweep']>
  > | null> {
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

    const summary = await this.runSweep();
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

  async runSweep(): Promise<{
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
      const now = new Date();
      await this.syncEnabledStates(now);
      const due = await this.stateModel
        .find({
          enabled: true,
          nextRivalProbeAt: { $lte: now },
          $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
        })
        .sort({ nextRivalProbeAt: 1 })
        .limit(this.timing.batchLimit)
        .lean<AutoUpdateProbeStateEntity[]>()
        .exec();

      const results = await this.runDueStates(due);
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
      const mapResults = await this.runDueMapStates(mapDue);
      const pendingFcfsDue = await this.stateModel
        .find({
          enabled: true,
          pendingRecentEventReason: { $in: FCFS_REASONS },
          $and: [
            {
              $or: [
                { nextRecentEventAt: null },
                { nextRecentEventAt: { $lte: now } },
              ],
            },
            {
              $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
            },
          ],
        })
        .sort({ nextRecentEventAt: 1 })
        .limit(this.timing.mapBatchLimit)
        .lean<AutoUpdateProbeStateEntity[]>()
        .exec();
      const pendingFcfs = await this.runDuePendingFcfsStates(
        pendingFcfsDue,
        now,
      );
      const pendingFullUpdateDue = await this.stateModel
        .find({
          enabled: true,
          pendingFullUpdateAt: { $lte: now },
          $or: [{ backoffUntil: null }, { backoffUntil: { $lte: now } }],
        })
        .sort({ pendingFullUpdateAt: 1 })
        .limit(this.timing.mapBatchLimit)
        .lean<AutoUpdateProbeStateEntity[]>()
        .exec();
      const pendingFullUpdate = await this.runDuePendingFullUpdateStates(
        pendingFullUpdateDue,
        now,
      );

      const triggered = results.filter((r) => r.action === 'triggered').length;
      const skippedNoChange =
        results.filter((r) => r.action === 'skipped').length +
        mapResults.filter((r) => r.action === 'skipped').length;
      const failed =
        results.filter((r) => r.action === 'failed').length +
        mapResults.filter((r) => r.action === 'failed').length;

      this.logger.log(
        `rival-first auto-update sweep done: ${triggered} changed, ${skippedNoChange} unchanged, ${failed} failed (rivalDue=${due.length}, mapDue=${mapDue.length}, pendingFcfsDue=${pendingFcfs.due}, pendingFcfsTriggered=${pendingFcfs.triggered}, pendingFcfsFailed=${pendingFcfs.failed}, pendingFullDue=${pendingFullUpdate.due}, pendingFullCreated=${pendingFullUpdate.created}, pendingFullCovered=${pendingFullUpdate.coveredByActive}, pendingFullFailed=${pendingFullUpdate.failed})`,
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

  private async syncEnabledStates(now: Date): Promise<void> {
    const users = await this.users.getAutoUpdateUsers();
    const activeFriendCodes = users.map((u) => u.friendCode);
    if (users.length) {
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
                  recentErrorCount: 0,
                  lastAutoUpdateActivityAt: null,
                  pendingFullUpdateAt: null,
                  lastRecentEventFingerprint: null,
                  pendingRecentEventReason: null,
                  pendingRecentEventRequestedAt: null,
                  pendingRecentEventCount: 0,
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

    await this.stateModel.updateMany(
      activeFriendCodes.length
        ? { friendCode: { $nin: activeFriendCodes }, enabled: true }
        : { enabled: true },
      { $set: { enabled: false } },
    );
  }

  private async runDueStates(
    states: AutoUpdateProbeStateEntity[],
  ): Promise<AutoUpdateProbeResult[]> {
    const results: AutoUpdateProbeResult[] = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.concurrency, states.length) },
      async () => {
        while (next < states.length) {
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
  ): Promise<AutoUpdateProbeResult[]> {
    const results: AutoUpdateProbeResult[] = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.mapConcurrency, states.length) },
      async () => {
        while (next < states.length) {
          const index = next++;
          results[index] = await this.processMapProbe(states[index]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async runDuePendingFcfsStates(
    states: AutoUpdateProbeStateEntity[],
    now: Date,
  ): Promise<PendingFcfsSummary> {
    const results: Array<'triggered' | 'failed' | 'skipped'> = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.mapConcurrency, states.length) },
      async () => {
        while (next < states.length) {
          const index = next++;
          results[index] = await this.processPendingFcfs(states[index], now);
        }
      },
    );
    await Promise.all(workers);
    return {
      due: states.length,
      triggered: results.filter((r) => r === 'triggered').length,
      failed: results.filter((r) => r === 'failed').length,
    };
  }

  private async processPendingFcfs(
    state: AutoUpdateProbeStateEntity,
    now: Date,
  ): Promise<'triggered' | 'failed' | 'skipped'> {
    const reason = this.normalizeFcfsReason(state.pendingRecentEventReason);
    if (!reason) {
      await this.stateModel.updateOne(
        { friendCode: state.friendCode },
        {
          $set: {
            pendingRecentEventReason: null,
            pendingRecentEventRequestedAt: null,
            pendingRecentEventCount: 0,
            schedulerVersion: SCHEDULER_VERSION,
          },
        },
      );
      return 'skipped';
    }

    try {
      await this.maybeEnqueueFcfs(state, reason, now);
      return 'triggered';
    } catch (err) {
      this.logger.warn(
        `failed to run pending fcfs enrichment fc=${state.friendCode}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return 'failed';
    }
  }

  private async runDuePendingFullUpdateStates(
    states: AutoUpdateProbeStateEntity[],
    now: Date,
  ): Promise<PendingFullUpdateSummary> {
    const results: Array<'created' | 'coveredByActive' | 'failed'> = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.timing.mapConcurrency, states.length) },
      async () => {
        while (next < states.length) {
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
      failed: results.filter((r) => r === 'failed').length,
    };
  }

  private async processPendingFullUpdate(
    state: AutoUpdateProbeStateEntity,
    now: Date,
  ): Promise<'created' | 'coveredByActive' | 'failed'> {
    try {
      const active = await this.jobs.getActiveUpdateScoreByFriendCode(
        state.friendCode,
      );
      if (active) {
        await this.clearPendingFullUpdate(state.friendCode);
        return 'coveredByActive';
      }

      await this.jobs.create({
        friendCode: state.friendCode,
        jobType: 'update_score',
        diffsToScrape: null,
        cancelActiveJobs: false,
        removeFriendAfterComplete: true,
        context: {
          source: 'auto_update_settled_full_update',
          lastActivityAt: state.lastAutoUpdateActivityAt?.toISOString() ?? null,
        },
      });
      await this.clearPendingFullUpdate(state.friendCode);
      return 'created';
    } catch (err) {
      await this.stateModel.updateOne(
        { friendCode: state.friendCode },
        {
          $set: {
            pendingFullUpdateAt: new Date(
              now.getTime() + this.timing.settledFullUpdateRetryMs,
            ),
            schedulerVersion: SCHEDULER_VERSION,
          },
        },
      );
      this.logger.warn(
        `failed to create settled full update fc=${state.friendCode}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return 'failed';
    }
  }

  private async clearPendingFullUpdate(friendCode: string): Promise<void> {
    await this.stateModel.updateOne(
      { friendCode },
      {
        $set: {
          pendingFullUpdateAt: null,
          schedulerVersion: SCHEDULER_VERSION,
        },
      },
    );
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
    this.enqueueRivalAutoExport(state.friendCode, sync.id, taskId);
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
    await this.enqueueFcfsAfterRivalChange(state, now);
    return {
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      action: 'triggered',
      message: `hash changed, merged ${Array.isArray(sync.scores) ? sync.scores.length : '?'} scores`,
    };
  }

  private enqueueRivalAutoExport(
    friendCode: string,
    syncId: string,
    taskId: string,
  ): void {
    this.proberExports
      .enqueueAutoExportForSync({
        trigger: 'auto_update_rival',
        friendCode,
        syncId,
        sourceTaskId: taskId,
      })
      .catch((err) =>
        this.logger.warn(
          `failed to enqueue rival auto-export fc=${friendCode}: ${
            err instanceof Error ? err.message : err
          }`,
        ),
      );
  }

  private async enqueueFcfsAfterRivalChange(
    state: AutoUpdateProbeStateEntity,
    now: Date,
  ): Promise<void> {
    await this.maybeEnqueueFcfs(state, 'rival_hash_changed', now).catch((err) =>
      this.logger.warn(
        `failed to enqueue fcfs enrichment fc=${state.friendCode}: ${
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
        await this.maybeEnqueueFcfs(state, 'map_delta', now).catch((err) =>
          this.logger.warn(
            `failed to enqueue map-triggered fcfs fc=${state.friendCode}: ${
              err instanceof Error ? err.message : err
            }`,
          ),
        );
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

  private async maybeEnqueueFcfs(
    state: AutoUpdateProbeStateEntity,
    reason: AutoUpdateFcfsReason,
    now: Date,
  ): Promise<void> {
    this.logger.warn(
      `FCFS enrichment disabled temporarily; skip addRival/get_user_recent_event fc=${state.friendCode} reason=${reason}`,
    );
    return;

    /*
     * Temporarily disabled as a production stopgap: this path uses sdgb
     * addRival before enqueueing get_user_recent_event and can rapidly fill
     * bot friend lists when many users are due.
     *
    if (state.nextRecentEventAt && state.nextRecentEventAt > now) {
      await this.deferFcfsUntilCooldown(state, reason, now);
      return;
    }

    const taskId = randomUUID();
    await this.taskModel.create({
      id: taskId,
      type: 'fcfs_enrichment',
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: this.timing.priorityForTier('hot'),
      runAt: now,
      attempts: 1,
      lastError: null,
      metrics: { reason },
    });

    try {
      const bot = await this.botStatus.pickAvailableCabinetBot();
      if (!bot) {
        throw new Error('no available cabinet bot for fcfs enrichment');
      }

      const addRival = await this.sdgb.addRival(
        {
          botCabinetUserId: bot.cabinetUserId,
          targetCabinetUserId: state.cabinetUserId,
        },
        { tag: `auto-fcfs-add:${state.friendCode}`, timeoutMs: 120_000 },
      );
      const { jobId } = await this.jobs.create({
        friendCode: state.friendCode,
        jobType: 'get_user_recent_event',
        botUserFriendCode: bot.friendCode,
        runAt: new Date(now.getTime() + this.timing.recentEventDelayMs),
        removeFriendAfterComplete: true,
        cancelActiveJobs: false,
        context: {
          autoUpdateFcfs: true,
          reason,
        },
      });
      const nextRecentEventAt = new Date(
        now.getTime() + this.timing.recentEventCooldownMs,
      );
      await Promise.all([
        this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              lastRecentEventAt: now,
              nextRecentEventAt,
              recentErrorCount: 0,
              pendingRecentEventReason: null,
              pendingRecentEventRequestedAt: null,
              pendingRecentEventCount: 0,
              schedulerVersion: SCHEDULER_VERSION,
            },
          },
        ),
        this.taskModel.updateOne(
          { id: taskId },
          {
            $set: {
              status: 'completed',
              updatedAt: new Date(),
              metrics: {
                reason,
                dxnetJobId: jobId,
                botFriendCode: bot.friendCode,
                addRival,
              },
            },
          },
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failureCount = (state.recentErrorCount ?? 0) + 1;
      const nextRecentEventAt = new Date(
        now.getTime() + this.timing.recentEventRetryDelayMs(failureCount),
      );
      await Promise.all([
        this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              recentErrorCount: failureCount,
              nextRecentEventAt,
              pendingRecentEventReason: this.mergeFcfsReason(
                state.pendingRecentEventReason,
                reason,
              ),
              pendingRecentEventRequestedAt:
                state.pendingRecentEventRequestedAt ?? now,
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
              updatedAt: new Date(),
            },
          },
        ),
      ]);
      throw err;
    }
    */
  }

  private async deferFcfsUntilCooldown(
    state: AutoUpdateProbeStateEntity,
    reason: AutoUpdateFcfsReason,
    now: Date,
  ): Promise<void> {
    await this.stateModel.updateOne(
      { friendCode: state.friendCode },
      {
        $set: {
          pendingRecentEventReason: this.mergeFcfsReason(
            state.pendingRecentEventReason,
            reason,
          ),
          pendingRecentEventRequestedAt: now,
          schedulerVersion: SCHEDULER_VERSION,
        },
        $inc: { pendingRecentEventCount: 1 },
      },
    );
  }

  private mergeFcfsReason(
    existing: unknown,
    next: AutoUpdateFcfsReason,
  ): AutoUpdateFcfsReason {
    const current = this.normalizeFcfsReason(existing);
    if (!current) {
      return next;
    }
    return FCFS_REASON_PRIORITY[next] > FCFS_REASON_PRIORITY[current]
      ? next
      : current;
  }

  private normalizeFcfsReason(value: unknown): AutoUpdateFcfsReason | null {
    return typeof value === 'string' &&
      FCFS_REASONS.includes(value as AutoUpdateFcfsReason)
      ? (value as AutoUpdateFcfsReason)
      : null;
  }
}
