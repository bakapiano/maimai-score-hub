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

import { UsersService } from '../../users/services/users.service';
import { JobService } from '../../job/services/job.service';
import { JobEntity } from '../../job/schemas/job.schema';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { SyncService } from '../../sync/services/sync.service';
import { AutoUpdateRunEntity } from '../schemas/auto-update-run.schema';
import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';

/** Per-user throttle for the sdgb hash-check call. */
const HASH_CHECK_THROTTLE_MS = 15 * 60 * 1000;
/** Per-user throttle for the dxnet update_score job creation. */
const AUTO_UPDATE_JOB_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Exponential backoff for users whose update_score jobs keep
 * failing. Reset to 0 on a successful job.
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
 *   0. If the user already has an in-flight update_score job, skip
 *      (we never want two competing jobs for the same user — the second
 *      one would cancel the first via JobService.create's "cancel older"
 *      rule).
 *   1. Try to claim a hash-check slot (CAS on user.lastHashCheckAt; at
 *      most once per HASH_CHECK_THROTTLE_MS).
 *   2. Ask sdgb-worker for the user's current rival-music hash.
 *   3. If the hash is unchanged from `lastScoreHash`, skip.
 *   4. Try to claim a job-creation slot (CAS on user.lastAutoUpdateJobAt;
 *      at most once per AUTO_UPDATE_JOB_THROTTLE_MS).
 *   5. Create an `update_score` job carrying the observed hash as
 *      `sourceScoreHash`. JobService completes cabinet-only jobs from
 *      the cabinet score map and promotes the hash to user.lastScoreHash
 *      ONLY after the job completes successfully.
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
    private readonly syncService: SyncService,
    @InjectModel(JobEntity.name)
    private readonly jobsModel: Model<JobEntity>,
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
        // instances do not all run the same sweep at the same tick.
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
      // the former nightly sweep used.
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
      // processing update_score job. We never want to fire a second
      // one for the same user — JobService.create cancels older jobs of
      // the same friendCode, which would waste the work in flight.
      const inflightRows = await this.jobsModel.aggregate<{ _id: string }>([
        {
          $match: {
            jobType: 'update_score',
            status: { $in: ['queued', 'processing'] },
          },
        },
        { $group: { _id: '$friendCode' } },
      ]);
      const inflightFc = new Set(inflightRows.map((r) => r._id));

      for (const u of users) {
        const cabinetUserId = u.cabinetUserId;
        if (cabinetUserId == null) continue;

        // (0a) Backoff: if a previous update_score job failed,
        // user.autoUpdateBackoffUntil is set to a future time. Skip
        // until the window expires. The window grows exponentially
        // with consecutive failures (see AUTO_UPDATE_BACKOFF_POLICY).
        // Reset happens in JobService.patch on successful completion.
        const backoffUntil = (u as { autoUpdateBackoffUntil?: Date | null })
          .autoUpdateBackoffUntil;
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
            message: 'update_score job still in flight',
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

          // (3) job-creation throttle: at most one update_score job
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

          // (5) create a cabinet-only update job; sourceScoreHash piggybacks
          // on the job and is promoted to user.lastScoreHash by
          // JobService.patch ONLY after the job completes successfully.
          await this.triggerUpdateForUser(u.friendCode, hash, music);
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
   * Create an update_score job. Cabinet-only mode is fixed on, so JobService
   * will complete the job from the cabinet score map when possible; the
   * preselected bot is only retained for worker fallback.
   */
  private async triggerUpdateForUser(
    friendCode: string,
    sourceScoreHash: string | null,
    cabinetMusic: SdgbWorkerMusicEntry[],
  ): Promise<void> {
    const bot = await this.botStatus.pickAvailableCabinetBot();
    if (!bot) {
      throw new Error(
        '没有可用的、配置了 cabinetUserId 的 bot — 请先在 admin 页面配置',
      );
    }

    // We just made a getRivalHash call (the hash check) and got the
    // music back. Pass it straight through to JobService.create —
    // JobService is the central place that derives cabinetScoreMap +
    // diffsToScrape (and admin trigger / immediate path use the same
    // logic). Without this transit JobService would make a redundant
    // sdgb call.
    const { jobId } = await this.jobs.create({
      friendCode,
      skipUpdateScore: false,
      jobType: 'update_score',
      botUserFriendCode: bot.friendCode,
      isAuthenticated: true,
      sourceScoreHash,
      cabinetMusic,
      allowCabinetOnlyShortCircuit: true,
    });

    this.logger.log(
      `auto-update job created fc=${friendCode} bot=${bot.friendCode} jobId=${jobId} sourceHash=${sourceScoreHash?.slice(0, 8) ?? '-'}`,
    );
  }
}
