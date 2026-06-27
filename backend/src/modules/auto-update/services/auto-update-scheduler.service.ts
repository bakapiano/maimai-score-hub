import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'crypto';
import { CronJob } from 'cron';
import type { Model } from 'mongoose';
import type { SdgbWorkerUserMapEntry } from '@maimai-score-hub/shared';

import { BotStatusService } from '../../bots/services/bot-status.service';
import { JobService } from '../../job/services/job.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { SyncService } from '../../sync/services/sync.service';
import { UsersService } from '../../users/services/users.service';
import { AUTO_UPDATE_BACKOFF_POLICY } from '../auto-update-backoff';
import {
  AutoUpdateProbeStateEntity,
  type AutoUpdateTier,
} from '../schemas/auto-update-probe-state.schema';
import { AutoUpdateRunEntity } from '../schemas/auto-update-run.schema';
import { AutoUpdateTaskEntity } from '../schemas/auto-update-task.schema';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SCHEDULER_VERSION = 'rival-first-v1';

function getPositiveInt(config: ConfigService, key: string, fallback: number) {
  const raw = config.get<string | number>(key);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function maxDate(...dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

function countDetails(music: Array<{ userRivalMusicDetailList?: unknown[] }>) {
  return music.reduce(
    (sum, item) => sum + (item.userRivalMusicDetailList?.length ?? 0),
    0,
  );
}

function deterministicOffsetMs(key: string, moduloMs: number): number {
  const digest = createHash('sha256').update(key).digest();
  const value = digest.readUInt32BE(0);
  return value % Math.max(1, moduloMs);
}

@Injectable()
export class AutoUpdateSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AutoUpdateSchedulerService.name);
  private readonly cronExpr: string;
  private readonly hotIntervalMs: number;
  private readonly warmIntervalMs: number;
  private readonly coldIntervalMs: number;
  private readonly hotSessionMs: number;
  private readonly warmMaxIdleMs: number;
  private readonly batchLimit: number;
  private readonly mapBatchLimit: number;
  private readonly concurrency: number;
  private readonly mapConcurrency: number;
  private readonly rivalTimeoutMs: number;
  private readonly mapTimeoutMs: number;
  private readonly recentEventCooldownMs: number;
  private readonly mapHotIntervalMs: number;
  private readonly mapWarmIntervalMs: number;
  private readonly mapColdIntervalMs: number;
  private cron: CronJob | null = null;
  private running = false;

  constructor(
    private readonly users: UsersService,
    private readonly jobs: JobService,
    private readonly botStatus: BotStatusService,
    private readonly sdgb: SdgbJobDispatcher,
    private readonly syncService: SyncService,
    @InjectModel(AutoUpdateProbeStateEntity.name)
    private readonly stateModel: Model<AutoUpdateProbeStateEntity>,
    @InjectModel(AutoUpdateTaskEntity.name)
    private readonly taskModel: Model<AutoUpdateTaskEntity>,
    @InjectModel(AutoUpdateRunEntity.name)
    private readonly runsModel: Model<AutoUpdateRunEntity>,
    config: ConfigService,
  ) {
    this.cronExpr = config.get<string>('AUTO_UPDATE_CRON', '*/1 * * * *');
    this.hotIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_HOT_INTERVAL_MS',
      10 * MINUTE,
    );
    this.warmIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_WARM_INTERVAL_MS',
      30 * MINUTE,
    );
    this.coldIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_COLD_INTERVAL_MS',
      HOUR,
    );
    this.hotSessionMs = getPositiveInt(
      config,
      'AUTO_UPDATE_HOT_SESSION_MS',
      90 * MINUTE,
    );
    this.warmMaxIdleMs = getPositiveInt(
      config,
      'AUTO_UPDATE_WARM_MAX_IDLE_MS',
      7 * DAY,
    );
    this.batchLimit = getPositiveInt(
      config,
      'AUTO_UPDATE_RIVAL_BATCH_LIMIT',
      480,
    );
    this.mapBatchLimit = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_BATCH_LIMIT',
      120,
    );
    this.concurrency = getPositiveInt(
      config,
      'AUTO_UPDATE_RIVAL_CONCURRENCY',
      4,
    );
    this.mapConcurrency = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_CONCURRENCY',
      2,
    );
    this.rivalTimeoutMs = getPositiveInt(
      config,
      'AUTO_UPDATE_RIVAL_TIMEOUT_MS',
      120_000,
    );
    this.mapTimeoutMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_TIMEOUT_MS',
      60_000,
    );
    this.recentEventCooldownMs = getPositiveInt(
      config,
      'AUTO_UPDATE_RECENT_EVENT_COOLDOWN_MS',
      30 * MINUTE,
    );
    this.mapHotIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_HOT_INTERVAL_MS',
      30 * MINUTE,
    );
    this.mapWarmIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_WARM_INTERVAL_MS',
      HOUR,
    );
    this.mapColdIntervalMs = getPositiveInt(
      config,
      'AUTO_UPDATE_MAP_COLD_INTERVAL_MS',
      HOUR,
    );
  }

  onModuleInit() {
    this.cron = new CronJob(
      this.cronExpr,
      () => {
        this.runSweepClaimed().catch((err) =>
          this.logger.error('Auto-update cron sweep failed', err),
        );
      },
      null,
      true,
    );
    this.logger.log(
      `Rival-first auto-update scheduler started (cron=${this.cronExpr})`,
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

    if (!won) return null;

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
        .limit(this.batchLimit)
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
        .limit(this.mapBatchLimit)
        .lean<AutoUpdateProbeStateEntity[]>()
        .exec();
      const mapResults = await this.runDueMapStates(mapDue);

      const triggered = results.filter((r) => r.action === 'triggered').length;
      const skippedNoChange =
        results.filter((r) => r.action === 'skipped').length +
        mapResults.filter((r) => r.action === 'skipped').length;
      const failed =
        results.filter((r) => r.action === 'failed').length +
        mapResults.filter((r) => r.action === 'failed').length;

      this.logger.log(
        `rival-first auto-update sweep done: ${triggered} changed, ${skippedNoChange} unchanged, ${failed} failed (rivalDue=${due.length}, mapDue=${mapDue.length})`,
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
          const initialDue = new Date(
            now.getTime() +
              deterministicOffsetMs(u.friendCode, this.coldIntervalMs),
          );
          const initialMapDue = new Date(
            now.getTime() +
              deterministicOffsetMs(
                `map:${u.friendCode}`,
                this.mapColdIntervalMs,
              ),
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

  private async runDueStates(states: AutoUpdateProbeStateEntity[]): Promise<
    Array<{
      friendCode: string;
      cabinetUserId: number;
      action: 'triggered' | 'skipped' | 'failed';
      message?: string;
    }>
  > {
    const results: Array<{
      friendCode: string;
      cabinetUserId: number;
      action: 'triggered' | 'skipped' | 'failed';
      message?: string;
    }> = new Array(states.length);
    let next = 0;
    const workers = new Array(Math.min(this.concurrency, states.length))
      .fill(null)
      .map(async () => {
        while (next < states.length) {
          const index = next++;
          results[index] = await this.processRivalProbe(states[index]);
        }
      });
    await Promise.all(workers);
    return results;
  }

  private async runDueMapStates(states: AutoUpdateProbeStateEntity[]): Promise<
    Array<{
      friendCode: string;
      cabinetUserId: number;
      action: 'triggered' | 'skipped' | 'failed';
      message?: string;
    }>
  > {
    const results: Array<{
      friendCode: string;
      cabinetUserId: number;
      action: 'triggered' | 'skipped' | 'failed';
      message?: string;
    }> = new Array(states.length);
    let next = 0;
    const workers = new Array(Math.min(this.mapConcurrency, states.length))
      .fill(null)
      .map(async () => {
        while (next < states.length) {
          const index = next++;
          results[index] = await this.processMapProbe(states[index]);
        }
      });
    await Promise.all(workers);
    return results;
  }

  private async processRivalProbe(state: AutoUpdateProbeStateEntity): Promise<{
    friendCode: string;
    cabinetUserId: number;
    action: 'triggered' | 'skipped' | 'failed';
    message?: string;
  }> {
    const taskId = randomUUID();
    const startedAt = Date.now();
    await this.taskModel.create({
      id: taskId,
      type: 'rival_score_probe',
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: this.priorityForTier(state.tier),
      runAt: new Date(),
      attempts: 1,
      lastError: null,
      metrics: null,
    });

    try {
      const { hash, music } = await this.sdgb.getRivalHash(
        { cabinetUserId: state.cabinetUserId },
        {
          tag: `auto-rival:${state.friendCode}`,
          timeoutMs: this.rivalTimeoutMs,
        },
      );
      const now = new Date();
      const durationMs = Date.now() - startedAt;
      const hashChanged = hash !== state.lastRivalHash;
      const musicCount = music.length;
      const detailCount = countDetails(music);

      if (hashChanged) {
        const sync = await this.syncService.createFromRivalMusic({
          friendCode: state.friendCode,
          sourceId: taskId,
          music,
        });
        if (!sync) {
          throw new Error('rival music returned no mappable scores');
        }

        await this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              tier: 'hot',
              lastRivalHash: hash,
              lastRivalProbeAt: now,
              lastScoreChangedAt: now,
              nextRivalProbeAt: this.nextProbeAt('hot', now, state),
              rivalErrorCount: 0,
              backoffUntil: null,
              schedulerVersion: SCHEDULER_VERSION,
            },
          },
        );
        await this.completeTask(taskId, {
          durationMs,
          hashChanged,
          musicCount,
          detailCount,
          scoreCount: Array.isArray(sync.scores) ? sync.scores.length : null,
        });
        await this.maybeEnqueueFcfs(state, 'rival_hash_changed', now).catch(
          (err) =>
            this.logger.warn(
              `failed to enqueue fcfs enrichment fc=${state.friendCode}: ${
                err instanceof Error ? err.message : err
              }`,
            ),
        );
        return {
          friendCode: state.friendCode,
          cabinetUserId: state.cabinetUserId,
          action: 'triggered',
          message: `hash changed, merged ${Array.isArray(sync.scores) ? sync.scores.length : '?'} scores`,
        };
      }

      const nextTier = this.decayTier(state, now);
      await this.stateModel.updateOne(
        { friendCode: state.friendCode },
        {
          $set: {
            tier: nextTier,
            lastRivalProbeAt: now,
            nextRivalProbeAt: this.nextProbeAt(nextTier, now, state),
            rivalErrorCount: 0,
            backoffUntil: null,
            schedulerVersion: SCHEDULER_VERSION,
          },
        },
      );
      await this.completeTask(taskId, {
        durationMs,
        hashChanged,
        musicCount,
        detailCount,
      });
      return {
        friendCode: state.friendCode,
        cabinetUserId: state.cabinetUserId,
        action: 'skipped',
        message: 'hash unchanged',
      };
    } catch (err) {
      const now = new Date();
      const msg = err instanceof Error ? err.message : String(err);
      const failureCount = (state.rivalErrorCount ?? 0) + 1;
      const backoffUntil = new Date(
        now.getTime() + this.backoffDelayMs(failureCount),
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
      priority: this.priorityForTier(state.tier),
      runAt: new Date(),
      attempts: 1,
      lastError: null,
      metrics: null,
    });

    try {
      const { maps } = await this.sdgb.getUserMap(
        { cabinetUserId: state.cabinetUserId },
        { tag: `auto-map:${state.friendCode}`, timeoutMs: this.mapTimeoutMs },
      );
      const now = new Date();
      const fingerprint = this.mapFingerprint(maps);
      const changed =
        state.mapFingerprint != null &&
        state.mapFingerprint !== fingerprint.mapFingerprint;
      const nextTier: AutoUpdateTier = changed
        ? 'hot'
        : this.decayTier(state, now);
      const set: Record<string, unknown> = {
        tier: nextTier,
        mapFingerprint: fingerprint.mapFingerprint,
        mapDistanceSum: fingerprint.mapDistanceSum,
        lastMapProbeAt: now,
        nextMapProbeAt: this.nextMapProbeAt(nextTier, now, state),
        mapErrorCount: 0,
        backoffUntil: null,
        schedulerVersion: SCHEDULER_VERSION,
      };

      if (changed) {
        set.lastMapDeltaAt = now;
        if (this.shouldProbeRivalNow(state, now)) {
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
        now.getTime() + Math.min(HOUR, 5 * MINUTE * failureCount),
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
    reason: 'rival_hash_changed' | 'map_delta' | 'manual',
    now: Date,
  ): Promise<void> {
    if (state.nextRecentEventAt && state.nextRecentEventAt > now) return;

    const taskId = randomUUID();
    await this.taskModel.create({
      id: taskId,
      type: 'fcfs_enrichment',
      friendCode: state.friendCode,
      cabinetUserId: state.cabinetUserId,
      status: 'processing',
      priority: this.priorityForTier('hot'),
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
        cancelActiveJobs: false,
        context: {
          autoUpdateFcfs: true,
          reason,
          recentEventSince: state.lastRecentEventAt?.toISOString() ?? null,
        },
      });
      const nextRecentEventAt = new Date(
        now.getTime() + this.recentEventCooldownMs,
      );
      await Promise.all([
        this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              lastRecentEventAt: now,
              nextRecentEventAt,
              recentErrorCount: 0,
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
      await Promise.all([
        this.stateModel.updateOne(
          { friendCode: state.friendCode },
          {
            $set: {
              recentErrorCount: failureCount,
              nextRecentEventAt: new Date(
                now.getTime() + Math.min(6 * HOUR, 30 * MINUTE * failureCount),
              ),
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
  }

  private priorityForTier(tier: AutoUpdateTier): number {
    if (tier === 'hot') return 30;
    if (tier === 'warm') return 10;
    return 0;
  }

  private intervalForTier(tier: AutoUpdateTier): number {
    if (tier === 'hot') return this.hotIntervalMs;
    if (tier === 'warm') return this.warmIntervalMs;
    return this.coldIntervalMs;
  }

  private mapIntervalForTier(tier: AutoUpdateTier): number {
    if (tier === 'hot') return this.mapHotIntervalMs;
    if (tier === 'warm') return this.mapWarmIntervalMs;
    return this.mapColdIntervalMs;
  }

  private nextProbeAt(
    tier: AutoUpdateTier,
    now: Date,
    state: AutoUpdateProbeStateEntity,
  ): Date {
    const base = this.intervalForTier(tier);
    const habitMultiplier = Number.isFinite(state.habitMultiplier)
      ? state.habitMultiplier
      : 1;
    const loadMultiplier = Number.isFinite(state.loadMultiplier)
      ? state.loadMultiplier
      : 1;
    const ms = Math.max(
      MINUTE,
      Math.floor(base * habitMultiplier * loadMultiplier),
    );
    return new Date(now.getTime() + ms);
  }

  private nextMapProbeAt(
    tier: AutoUpdateTier,
    now: Date,
    state: AutoUpdateProbeStateEntity,
  ): Date {
    const base = this.mapIntervalForTier(tier);
    const loadMultiplier = Number.isFinite(state.loadMultiplier)
      ? state.loadMultiplier
      : 1;
    return new Date(
      now.getTime() + Math.max(MINUTE, Math.floor(base * loadMultiplier)),
    );
  }

  private shouldProbeRivalNow(
    state: AutoUpdateProbeStateEntity,
    now: Date,
  ): boolean {
    if (!state.lastRivalProbeAt) return true;
    return (
      now.getTime() - state.lastRivalProbeAt.getTime() >=
      this.intervalForTier(state.tier)
    );
  }

  private mapFingerprint(maps: SdgbWorkerUserMapEntry[]): {
    mapFingerprint: string;
    mapDistanceSum: number;
    rowCount: number;
  } {
    const pairs = maps
      .filter((m) => Number.isFinite(m.mapId) && Number.isFinite(m.distance))
      .map((m) => [m.mapId, m.distance] as const)
      .sort((a, b) => a[0] - b[0]);
    const stable = pairs
      .map(([mapId, distance]) => `${mapId}:${distance}`)
      .join('|');
    return {
      mapFingerprint: createHash('sha256').update(stable).digest('hex'),
      mapDistanceSum: pairs.reduce((sum, [, distance]) => sum + distance, 0),
      rowCount: pairs.length,
    };
  }

  private decayTier(
    state: AutoUpdateProbeStateEntity,
    now: Date,
  ): AutoUpdateTier {
    const lastSignal = maxDate(state.lastScoreChangedAt, state.lastMapDeltaAt);
    if (!lastSignal) return 'cold';
    const idleMs = now.getTime() - lastSignal.getTime();
    if (state.tier === 'hot' && idleMs <= this.hotSessionMs) return 'hot';
    if (idleMs <= this.warmMaxIdleMs) return 'warm';
    return 'cold';
  }

  private backoffDelayMs(failureCount: number): number {
    return Math.min(
      AUTO_UPDATE_BACKOFF_POLICY.capMs,
      Math.floor(
        AUTO_UPDATE_BACKOFF_POLICY.baseMs *
          Math.pow(AUTO_UPDATE_BACKOFF_POLICY.factor, failureCount - 1),
      ),
    );
  }
}
