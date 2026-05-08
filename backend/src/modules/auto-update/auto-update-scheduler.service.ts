import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';

import { UsersService } from '../users/users.service';
import { JobService } from '../job/job.service';
import { BotStatusService } from '../admin/bot-status.service';
import { SdgbJobDispatcher } from '../sdgb-worker/sdgb-job.dispatcher';

/**
 * Polls every AUTO_UPDATE_CRON tick (default: every 15 minutes) and, for
 * each user that has cabinetUserId bound + autoUpdate=true:
 *
 *   1. Ask sdgb-worker for the user's current rival-music hash.
 *   2. If the hash is unchanged from `lastScoreHash`, skip.
 *   3. Otherwise unconditionally store the new hash, then in parallel:
 *        - Tell sdgb-worker to add the bot as the user's cabinet rival
 *          (replaces the manual "accept friend on cabinet" step).
 *        - Create an `idle_update_score` job for the worker/ service to
 *          actually scrape DXNet and persist the new scores.
 *
 * Storing the hash before kicking off the work is intentional (per spec):
 * even if the job fails, we should not retrigger on the same hash.
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
    config: ConfigService,
  ) {
    this.cronExpr = config.get<string>('AUTO_UPDATE_CRON', '*/15 * * * *');
  }

  onModuleInit() {
    this.cron = new CronJob(
      this.cronExpr,
      () => {
        this.runSweep().catch((err) =>
          this.logger.error('Auto-update sweep failed', err),
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

      for (const u of users) {
        const cabinetUserId = u.cabinetUserId;
        if (cabinetUserId == null) continue;
        try {
          const { hash } = await this.sdgb.getRivalHash(
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

          // Store the hash unconditionally before doing any side-effecting
          // work; per spec, a failed job should not cause us to retrigger
          // on the same observed hash.
          await this.users.setLastScoreHash(String(u._id), hash);

          await this.triggerUpdateForUser(u.friendCode, cabinetUserId);
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
  ): Promise<void> {
    const bot = await this.botStatus.pickAvailableCabinetBot();
    if (!bot) {
      throw new Error(
        '没有可用的、配置了 cabinetUserId 的 bot — 请先在 admin 页面配置',
      );
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
      this.jobs
        .create({
          friendCode,
          skipUpdateScore: false,
          jobType: 'idle_update_score',
          botUserFriendCode: bot.friendCode,
          isAuthenticated: true,
        })
        .then(({ jobId }) =>
          this.logger.log(
            `auto-update job created fc=${friendCode} bot=${bot.friendCode} jobId=${jobId}`,
          ),
        ),
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
}
