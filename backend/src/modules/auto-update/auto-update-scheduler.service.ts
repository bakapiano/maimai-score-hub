import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { CronJob } from 'cron';

import { UsersService } from '../users/users.service';
import { JobService } from '../job/job.service';
import { JobEntity } from '../job/job.schema';
import { BotStatusService } from '../admin/bot-status.service';
import { SdgbJobDispatcher } from '../sdgb-worker/sdgb-job.dispatcher';
import { SystemSettingsService } from '../admin/system-settings.service';
import { SdgbJobEntity } from '../sdgb-worker/sdgb-job.schema';
import { SyncService } from '../sync/sync.service';
import { AutoUpdateRunEntity } from './auto-update-run.schema';
import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';

/** Per-user throttle for the sdgb hash-check call. */
const HASH_CHECK_THROTTLE_MS = 15 * 60 * 1000;
/** Per-user throttle for the dxnet idle_update_score job creation. */
const AUTO_UPDATE_JOB_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Exponential backoff for users whose idle_update_score jobs keep
 * failing. Reset to 0 on a successful job OR on an admin manual
 * trigger.
 *
 * Why bother? Without backoff a persistently failing user (cookie
 * died, bot got banned, cabinet refused) keeps consuming a bot slot
 * every AUTO_UPDATE_JOB_THROTTLE_MS forever, drowning out healthy
 * users in the same bot's queue.
 *
 * Concrete numbers live in ./auto-update-backoff.ts so JobService
 * can share them without importing the scheduler module.
 */

/**
 * Polls every AUTO_UPDATE_CRON tick (default: every 5 minutes) and, for
 * each user that has cabinetUserId bound + autoUpdate=true:
 *
 *   0. If the user already has an in-flight idle_update_score job, skip
 *      (we never want two competing jobs for the same user — the second
 *      one would cancel the first via JobService.create's "cancel older"
 *      rule).
 *   1. Try to claim a hash-check slot (CAS on user.lastHashCheckAt; at
 *      most once per HASH_CHECK_THROTTLE_MS).
 *   2. Ask sdgb-worker for the user's current rival-music hash.
 *   3. If the hash is unchanged from `lastScoreHash`, skip.
 *   4. Try to claim a job-creation slot (CAS on user.lastAutoUpdateJobAt;
 *      at most once per AUTO_UPDATE_JOB_THROTTLE_MS).
 *   5. In parallel:
 *        - Tell sdgb-worker to add the bot as the user's cabinet rival
 *          (replaces the manual "accept friend on cabinet" step).
 *        - Create an `idle_update_score` job carrying the observed hash
 *          as `sourceScoreHash`. JobService.patch promotes that hash to
 *          user.lastScoreHash ONLY after the job completes successfully.
 *
 * The "promote on success" rule means a failed/canceled job leaves the
 * stored hash alone, so the next sweep retries the same diff.
 */
@Injectable()
export class AutoUpdateSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AutoUpdateSchedulerService.name);
  private cron: CronJob | null = null;
  private running = false;

  private readonly cronExpr: string;

  constructor(
    private readonly users: UsersService,
    private readonly jobs: JobService,
    private readonly botStatus: BotStatusService,
    private readonly sdgb: SdgbJobDispatcher,
    private readonly systemSettings: SystemSettingsService,
    private readonly syncService: SyncService,
    @InjectModel(JobEntity.name)
    private readonly jobsModel: Model<JobEntity>,
    @InjectModel(SdgbJobEntity.name)
    private readonly sdgbJobsModel: Model<SdgbJobEntity>,
    @InjectModel(AutoUpdateRunEntity.name)
    private readonly runsModel: Model<AutoUpdateRunEntity>,
    config: ConfigService,
  ) {
    this.cronExpr = config.get<string>('AUTO_UPDATE_CRON', '*/5 * * * *');
  }

  onModuleInit() {
    this.cron = new CronJob(
      this.cronExpr,
      () => {
        // Cron-fired sweeps must claim the bucket so that multiple backend
        // instances do not all run the same sweep at the same tick. Manual
        // admin-triggered sweeps go through runSweep() directly with no
        // claim, which is intentional ("force run now").
        this.runSweepClaimed().catch((err) =>
          this.logger.error('Auto-update cron sweep failed', err),
        );
      },
      null,
      true,
    );
    this.logger.log(`Auto-update scheduler started (cron=${this.cronExpr})`);
  }

  onModuleDestroy() {
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * Compute the bucket key for the cron tick that JUST fired (or, for
   * out-of-cron callers, the closest preceding tick). We use the CronJob's
   * own `lastDate()` when available so the key is exactly aligned with the
   * cron expression — no separate rounding logic to drift out of sync.
   */
  private currentBucketKey(): string {
    const last = this.cron?.lastDate();
    const ref = last instanceof Date ? last : new Date();
    // ISO minute precision in UTC. Using UTC avoids two instances in
    // different timezones disagreeing on the bucket.
    return ref.toISOString().slice(0, 16);
  }

  /**
   * Cron-driven entrypoint. Tries to claim the current bucket; if some
   * other instance already won, returns null without doing any work.
   */
  private async runSweepClaimed(): Promise<ReturnType<
    AutoUpdateSchedulerService['runSweep']
  > | null> {
    const bucketKey = this.currentBucketKey();
    let won = false;
    try {
      // Atomic upsert + returnDocument: 'before' — same trick
      // IdleUpdateLogService.tryAcquire uses for the nightly sweep.
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
      // Duplicate-key race: another instance got the doc inserted between
      // our findOne (which returned null) and our upsert. Treat as "lost".
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('E11000')) {
        won = false;
      } else {
        throw err;
      }
    }

    if (!won) {
      this.logger.debug?.(
        `auto-update bucket=${bucketKey} already claimed by another instance, skipping`,
      );
      return null;
    }

    this.logger.log(`auto-update bucket=${bucketKey} claimed, running sweep`);
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

  /**
   * Manual / test entrypoint. Returns a summary of the sweep so the admin
   * controller (or jest tests) can assert the per-user behaviour.
   */
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
      const users = await this.users.getAutoUpdateUsers();
      let triggered = 0;
      let skippedNoChange = 0;
      let failed = 0;
      const entries: Array<{
        friendCode: string;
        cabinetUserId: number;
        action: 'triggered' | 'skipped' | 'failed';
        message?: string;
      }> = [];

      // One-shot lookup of every friendCode that already has a queued or
      // processing idle_update_score job. We never want to fire a second
      // one for the same user — JobService.create cancels older jobs of
      // the same friendCode, which would waste the work in flight.
      const inflightRows = await this.jobsModel.aggregate<{ _id: string }>([
        {
          $match: {
            jobType: 'idle_update_score',
            status: { $in: ['queued', 'processing'] },
          },
        },
        { $group: { _id: '$friendCode' } },
      ]);
      const inflightFc = new Set(inflightRows.map((r) => r._id));

      for (const u of users) {
        const cabinetUserId = u.cabinetUserId;
        if (cabinetUserId == null) continue;

        // (0a) Backoff: if a previous idle_update_score job failed,
        // user.autoUpdateBackoffUntil is set to a future time. Skip
        // until the window expires. The window grows exponentially
        // with consecutive failures (see AUTO_UPDATE_BACKOFF_POLICY).
        // Reset happens in JobService.patch on successful completion
        // and in triggerByFriendCode on admin manual trigger.
        const backoffUntil = (
          u as { autoUpdateBackoffUntil?: Date | null }
        ).autoUpdateBackoffUntil;
        if (backoffUntil && backoffUntil.getTime() > Date.now()) {
          skippedNoChange++;
          const remainMin = Math.ceil(
            (backoffUntil.getTime() - Date.now()) / 60_000,
          );
          entries.push({
            friendCode: u.friendCode,
            cabinetUserId,
            action: 'skipped',
            message: `backoff (${(u as { autoUpdateFailureCount?: number }).autoUpdateFailureCount ?? '?'} fails, ${remainMin}m remaining)`,
          });
          continue;
        }

        // (0b) skip users whose previous job hasn't finished — checking the
        // hash again here would just produce noise.
        if (inflightFc.has(u.friendCode)) {
          skippedNoChange++;
          entries.push({
            friendCode: u.friendCode,
            cabinetUserId,
            action: 'skipped',
            message: 'idle_update_score job still in flight',
          });
          continue;
        }

        // (1) hash-check throttle: at most one sdgb call per user per
        // HASH_CHECK_THROTTLE_MS, even across backend instances.
        const claimedCheck = await this.users.tryClaimHashCheck(
          String(u._id),
          HASH_CHECK_THROTTLE_MS,
        );
        if (!claimedCheck) {
          skippedNoChange++;
          entries.push({
            friendCode: u.friendCode,
            cabinetUserId,
            action: 'skipped',
            message: 'hash check throttled',
          });
          continue;
        }

        try {
          // sdgb 既给 hash 又给完整 music — 一次调用拿两份。
          // music 让我们能：(a) 砍掉一半 friend-VS 请求（dxScore + achievement
          // 直接从 cabinet 取）；(b) 跟上次 sync 对比，只爬变化的难度。
          const { hash, music } = await this.sdgb.getRivalHash(
            { cabinetUserId },
            { tag: `auto-hash:${u.friendCode}`, timeoutMs: 120_000 },
          );
          if (hash === u.lastScoreHash) {
            skippedNoChange++;
            entries.push({
              friendCode: u.friendCode,
              cabinetUserId,
              action: 'skipped',
              message: 'hash unchanged',
            });
            continue;
          }

          // (3) job-creation throttle: at most one idle_update_score job
          // per AUTO_UPDATE_JOB_THROTTLE_MS. Combined with the in-flight
          // check above, this stops a long-running job from ever being
          // shadowed by a fresh one once the throttle window expires.
          const claimedJob = await this.users.tryClaimAutoUpdateJob(
            String(u._id),
            AUTO_UPDATE_JOB_THROTTLE_MS,
          );
          if (!claimedJob) {
            skippedNoChange++;
            entries.push({
              friendCode: u.friendCode,
              cabinetUserId,
              action: 'skipped',
              message: 'auto-update job throttled',
            });
            continue;
          }

          // (5) create job + addRival; sourceScoreHash piggybacks on the
          // job and is promoted to user.lastScoreHash by JobService.patch
          // ONLY after the job completes successfully.
          await this.triggerUpdateForUser(u.friendCode, cabinetUserId, hash, music);
          triggered++;
          entries.push({
            friendCode: u.friendCode,
            cabinetUserId,
            action: 'triggered',
          });
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `auto-update fc=${u.friendCode} cabinetUid=${cabinetUserId} failed: ${msg}`,
          );
          entries.push({
            friendCode: u.friendCode,
            cabinetUserId,
            action: 'failed',
            message: msg,
          });
        }
      }

      this.logger.log(
        `auto-update sweep done: ${triggered} triggered, ${skippedNoChange} skipped, ${failed} failed (of ${users.length} users)`,
      );
      return {
        totalUsers: users.length,
        triggered,
        skippedNoChange,
        failed,
        entries,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Pick a bot that has a configured cabinetUserId and, in parallel,
   *   - schedule add-rival on the cabinet via sdgb-worker
   *   - create an idle_update_score job assigned to that bot for worker/
   * The two operations are independent: add-rival is idempotent on the
   * cabinet (returnCode 1 = already friends), and the worker/ side will
   * pick up the queued job whenever it next polls.
   */
  private async triggerUpdateForUser(
    friendCode: string,
    cabinetUserId: number,
    sourceScoreHash: string | null,
    cabinetMusic: SdgbWorkerMusicEntry[],
  ): Promise<void> {
    const bot = await this.botStatus.pickAvailableCabinetBot();
    if (!bot) {
      throw new Error(
        '没有可用的、配置了 cabinetUserId 的 bot — 请先在 admin 页面配置',
      );
    }

    // In cabinet-only mode, JobService short-circuits via getRivalHash
    // + cabinetScoreMap and never touches the bot's rival list, so an
    // addRival here is pure waste (and noise on the sdgb queue).
    let cabinetOnlyMode = false;
    try {
      cabinetOnlyMode = (await this.systemSettings.get()).cabinetOnlyMode;
    } catch (err) {
      this.logger.warn(
        `system-settings lookup failed; assuming bot-based flow: ${err instanceof Error ? err.message : err}`,
      );
    }

    // We just made a getRivalHash call (the hash check) and got the
    // music back. Pass it straight through to JobService.create —
    // JobService is the central place that derives cabinetScoreMap +
    // diffsToScrape (and admin trigger / immediate path use the same
    // logic). Without this transit JobService would make a redundant
    // sdgb call.
    const createJob = this.jobs
      .create({
        friendCode,
        skipUpdateScore: false,
        jobType: 'idle_update_score',
        botUserFriendCode: bot.friendCode,
        isAuthenticated: true,
        sourceScoreHash,
        cabinetMusic,
      })
      .then(({ jobId }) =>
        this.logger.log(
          `auto-update job created fc=${friendCode} bot=${bot.friendCode} jobId=${jobId} sourceHash=${sourceScoreHash?.slice(0, 8) ?? '-'}`,
        ),
      );

    if (cabinetOnlyMode) {
      await createJob;
      return;
    }

    await Promise.all([
      this.sdgb
        .addRival(
          {
            botCabinetUserId: bot.cabinetUserId,
            targetCabinetUserId: cabinetUserId,
          },
          { tag: `auto-add:${friendCode}`, timeoutMs: 120_000 },
        )
        .then((r) =>
          this.logger.log(
            `addRival fc=${friendCode} bot=${bot.friendCode} returnCodes=${r.returnCode1}/${r.returnCode2}`,
          ),
        )
        .catch((err) => {
          // Don't fail the whole trigger if add-rival itself errors; the
          // user might still be on each other's friends list. Just log it.
          this.logger.warn(
            `addRival fc=${friendCode} failed (continuing): ${err instanceof Error ? err.message : err}`,
          );
        }),
      createJob,
    ]);
  }

  /**
   * Admin manual trigger: skip the hash-diff check and just kick off the
   * full update flow for one user (add bot as cabinet rival + create
   * idle_update_score job). Used by `POST /auto-update/trigger` for
   * support-style "force-refresh this user now" use cases.
   *
   * Does NOT touch lastScoreHash so the next cron tick will still run
   * naturally if the hash is different by then.
   */
  async triggerByFriendCode(friendCode: string): Promise<{
    friendCode: string;
    cabinetUserId: number;
    bot: { friendCode: string; cabinetUserId: number };
    jobId: string;
    addRival:
      | { returnCode1: number; returnCode2: number }
      | { error: string };
  }> {
    const user = await this.users.findByFriendCode(friendCode);
    if (!user) {
      throw new Error(`user not found for friendCode=${friendCode}`);
    }
    const cabinetUserId = (user as { cabinetUserId?: number | null })
      .cabinetUserId;
    if (cabinetUserId == null) {
      throw new Error(
        `friendCode=${friendCode} 未绑定 cabinetUserId，请先在前台扫码绑定`,
      );
    }
    const bot = await this.botStatus.pickAvailableCabinetBot();
    if (!bot) {
      throw new Error('没有可用的、配置了 cabinetUserId 的 bot');
    }

    // Admin manual trigger clears any active backoff: the human just
    // told us this user matters now. If the forced refresh ALSO fails,
    // JobService.patch will re-record a failure and the backoff
    // sequence restarts from failureCount=1 (= 30m), not where it
    // left off — that's intentional, see decision in design doc.
    await this.users.resetAutoUpdateBackoff(String(user._id));

    const [addRivalResult, jobResult] = await Promise.all([
      this.sdgb
        .addRival(
          {
            botCabinetUserId: bot.cabinetUserId,
            targetCabinetUserId: cabinetUserId,
          },
          { tag: `admin-trigger:${friendCode}`, timeoutMs: 120_000 },
        )
        .then((r) => {
          this.logger.log(
            `[admin-trigger] addRival fc=${friendCode} returnCodes=${r.returnCode1}/${r.returnCode2}`,
          );
          return r as
            | { returnCode1: number; returnCode2: number }
            | { error: string };
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `[admin-trigger] addRival fc=${friendCode} failed (continuing): ${msg}`,
          );
          return { error: msg };
        }),
      this.jobs.create({
        friendCode,
        skipUpdateScore: false,
        jobType: 'idle_update_score',
        botUserFriendCode: bot.friendCode,
        isAuthenticated: true,
      }),
    ]);

    this.logger.log(
      `[admin-trigger] job created fc=${friendCode} bot=${bot.friendCode} jobId=${jobResult.jobId}`,
    );

    return {
      friendCode,
      cabinetUserId,
      bot,
      jobId: jobResult.jobId,
      addRival: addRivalResult,
    };
  }

  /**
   * Admin overview: every user that has autoUpdate=true, plus the most
   * recent dxnet idle_update_score job per friendCode and the latest sdgb
   * "auto-hash" job (so the admin can see whether the scheduler observed
   * a hash change recently).
   */
  async listAutoUpdateUsers(): Promise<
    Array<{
      friendCode: string;
      cabinetUserId: number | null;
      lastScoreHash: string | null;
      preferredBotFriendCode: string | null;
      autoUpdateFailureCount: number;
      autoUpdateBackoffUntil: string | null;
      lastIdleJob: {
        id: string;
        botUserFriendCode: string | null;
        status: string;
        stage: string;
        createdAt: string;
        updatedAt: string;
        error: string | null;
      } | null;
      lastHashJob: {
        id: string;
        status: string;
        result: Record<string, unknown> | null;
        error: string | null;
        createdAt: string;
        updatedAt: string;
      } | null;
    }>
  > {
    const users = await this.users.getAutoUpdateUsers();
    if (!users.length) return [];

    const friendCodes = users.map((u) => u.friendCode);

    // Get latest idle_update_score job per friendCode
    const latestIdleJobs = await this.jobsModel.aggregate<{
      _id: string;
      doc: {
        id: string;
        friendCode: string;
        botUserFriendCode: string | null;
        status: string;
        stage: string;
        error: string | null;
        createdAt: Date;
        updatedAt: Date;
      };
    }>([
      {
        $match: {
          friendCode: { $in: friendCodes },
          jobType: 'idle_update_score',
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$friendCode',
          doc: { $first: '$$ROOT' },
        },
      },
    ]);
    const idleByFc = new Map(latestIdleJobs.map((row) => [row._id, row.doc]));

    // Get latest sdgb get_rival_hash job per friendCode (matched via tag).
    // Tag format is "auto-hash:<friendCode>" or "admin-trigger:<friendCode>".
    const tags = friendCodes.flatMap((fc) => [
      `auto-hash:${fc}`,
      `admin-trigger:${fc}`,
    ]);
    const latestHashJobs = await this.sdgbJobsModel.aggregate<{
      _id: string;
      doc: {
        id: string;
        status: string;
        result: Record<string, unknown> | null;
        error: string | null;
        requesterTag: string;
        createdAt: Date;
        updatedAt: Date;
      };
    }>([
      {
        $match: {
          jobType: 'get_rival_hash',
          requesterTag: { $in: tags },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$requesterTag',
          doc: { $first: '$$ROOT' },
        },
      },
    ]);
    const hashByFc = new Map<string, (typeof latestHashJobs)[number]['doc']>();
    for (const row of latestHashJobs) {
      const fc = row._id.split(':')[1];
      if (!fc) continue;
      const existing = hashByFc.get(fc);
      if (!existing || existing.createdAt < row.doc.createdAt) {
        hashByFc.set(fc, row.doc);
      }
    }

    // aggregate $$ROOT can return createdAt/updatedAt as either Date or
    // string depending on mongoose path resolution — normalize before
    // calling .toISOString(). Same defensive coerce for user fields.
    const toIso = (v: Date | string | null | undefined): string | null => {
      if (v == null) return null;
      if (v instanceof Date) return v.toISOString();
      return new Date(v).toISOString();
    };

    return users.map((u) => {
      const idle = idleByFc.get(u.friendCode);
      const hash = hashByFc.get(u.friendCode);
      return {
        friendCode: u.friendCode,
        cabinetUserId:
          (u as { cabinetUserId?: number | null }).cabinetUserId ?? null,
        lastScoreHash:
          (u as { lastScoreHash?: string | null }).lastScoreHash ?? null,
        preferredBotFriendCode:
          (u as { preferredBotFriendCode?: string | null })
            .preferredBotFriendCode ?? null,
        autoUpdateFailureCount:
          (u as { autoUpdateFailureCount?: number }).autoUpdateFailureCount ??
          0,
        autoUpdateBackoffUntil:
          toIso(
            (u as { autoUpdateBackoffUntil?: Date | string | null })
              .autoUpdateBackoffUntil,
          ),
        lastIdleJob: idle
          ? {
              id: idle.id,
              botUserFriendCode: idle.botUserFriendCode ?? null,
              status: idle.status,
              stage: idle.stage,
              createdAt: toIso(idle.createdAt)!,
              updatedAt: toIso(idle.updatedAt)!,
              error: idle.error ?? null,
            }
          : null,
        lastHashJob: hash
          ? {
              id: hash.id,
              status: hash.status,
              result: hash.result ?? null,
              error: hash.error ?? null,
              createdAt: toIso(hash.createdAt)!,
              updatedAt: toIso(hash.updatedAt)!,
            }
          : null,
      };
    });
  }

  /**
   * Per-user activity timeline used by the admin "查看历史" modal. Pulls
   * the last N sdgb hash-check jobs (matched by requesterTag) and the
   * last N dxnet idle_update_score jobs for that friendCode, then merges
   * them by createdAt desc so the admin can see whether the hash actually
   * changed at each tick — and whether the resulting refresh job ran.
   *
   * Each entry carries `kind` so the FE can render heterogeneously.
   */
  async getUserJobHistory(
    friendCode: string,
    limit = 30,
  ): Promise<UserJobHistoryEntry[]> {
    const tags = [
      `auto-hash:${friendCode}`,
      `admin-trigger:${friendCode}`,
      `auto-add:${friendCode}`,
    ];
    const [hashDocs, jobDocs] = await Promise.all([
      this.sdgbJobsModel
        .find({
          jobType: 'get_rival_hash',
          requesterTag: { $in: tags },
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      this.jobsModel
        .find({
          friendCode,
          jobType: 'idle_update_score',
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
    ]);

    const merged: Array<{ createdAt: Date; entry: UserJobHistoryEntry }> = [
      ...hashDocs.map((d) => ({
        createdAt: d.createdAt,
        entry: {
          kind: 'hash_check' as const,
          id: d.id,
          status: d.status,
          requesterTag: d.requesterTag ?? null,
          hash:
            d.result && typeof d.result.hash === 'string'
              ? (d.result.hash as string)
              : null,
          error: d.error ?? null,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        },
      })),
      ...jobDocs.map((d) => ({
        createdAt: d.createdAt,
        entry: {
          kind: 'update_job' as const,
          id: d.id,
          status: d.status,
          stage: d.stage,
          botUserFriendCode: d.botUserFriendCode ?? null,
          error: d.error ?? null,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        },
      })),
    ];
    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return merged.slice(0, limit).map((m) => m.entry);
  }
}

export type UserJobHistoryEntry =
  | {
      kind: 'hash_check';
      id: string;
      status: string;
      requesterTag: string | null;
      /** md5 from result.hash, when present */
      hash: string | null;
      /** error message when status === failed */
      error: string | null;
      createdAt: string;
      updatedAt: string;
    }
  | {
      kind: 'update_job';
      id: string;
      status: string;
      stage: string;
      botUserFriendCode: string | null;
      error: string | null;
      createdAt: string;
      updatedAt: string;
    };
