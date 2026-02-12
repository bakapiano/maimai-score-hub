import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { IdleUpdateLogService } from './idle-update-log.service';
import { JobService } from './job.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class IdleUpdateSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IdleUpdateSchedulerService.name);
  private intervalId: NodeJS.Timeout | null = null;

  /** UTC+8 小时数，默认 0 点 */
  private readonly idleUpdateHour: number;
  /** 并发度（每次调度创建多少个 job） */
  private readonly concurrency: number;

  constructor(
    private readonly jobService: JobService,
    private readonly usersService: UsersService,
    private readonly idleUpdateLogService: IdleUpdateLogService,
    config: ConfigService,
  ) {
    this.idleUpdateHour = Number(config.get<string>('IDLE_UPDATE_HOUR', '0'));
    this.concurrency = Number(
      config.get<string>('IDLE_UPDATE_CONCURRENCY', '5'),
    );
  }

  onModuleInit() {
    // 每分钟检查一次是否到了闲时更新时间
    this.intervalId = setInterval(() => {
      this.checkAndTrigger().catch((err) => {
        this.logger.error('Idle update scheduler error', err);
      });
    }, 60 * 1000);

    this.logger.log(
      `Idle update scheduler started (hour=${this.idleUpdateHour} UTC+8, concurrency=${this.concurrency})`,
    );
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async checkAndTrigger(): Promise<void> {
    // 获取 UTC+8 时间
    const now = new Date();
    const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const hour = utc8.getUTCHours();
    const dateKey = utc8.toISOString().slice(0, 10);

    // 只在目标小时执行
    if (hour !== this.idleUpdateHour) {
      return;
    }

    // 通过 DB 原子操作竞争触发权，确保多 instance 只触发一次
    const acquired = await this.idleUpdateLogService.tryAcquire(dateKey);
    if (!acquired) {
      return;
    }

    const result = await this.triggerNow();

    // 记录本次触发的详细结果
    await this.idleUpdateLogService.finalize(dateKey, {
      totalUsers: result.totalUsers,
      created: result.created,
      failed: result.failed,
      entries: result.entries,
    });
  }

  /** 轮询间隔(ms) */
  private readonly POLL_INTERVAL_MS = 3000;
  /** 单个 job 最大等待时间(ms) */
  private readonly JOB_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * 手动 / 定时 触发闲时更新，返回执行结果摘要。
   */
  async triggerNow(): Promise<{
    totalUsers: number;
    created: number;
    failed: number;
    entries: Array<{ friendCode: string; jobId: string }>;
  }> {
    this.logger.log('Triggering idle update jobs');

    const users = await this.usersService.getIdleUpdateUsers();
    if (!users.length) {
      this.logger.log('No users with idle update enabled');
      return { totalUsers: 0, created: 0, failed: 0, entries: [] };
    }

    let created = 0;
    let failed = 0;
    const entries: Array<{ friendCode: string; jobId: string }> = [];

    // 按 concurrency 分批处理
    for (let i = 0; i < users.length; i += this.concurrency) {
      const batch = users.slice(i, i + this.concurrency);
      const batchJobIds: string[] = [];

      // 1) 创建这一批的所有 job
      for (const user of batch) {
        try {
          const { jobId } = await this.jobService.create({
            friendCode: user.friendCode,
            skipUpdateScore: false,
            jobType: 'idle_update_score',
            botUserFriendCode: user.idleUpdateBotFriendCode,
          });

          // 清除用户的闲时更新标记
          const userId = String(user._id);
          await this.usersService.update(userId, {
            idleUpdateBotFriendCode: null,
          });

          batchJobIds.push(jobId);
          entries.push({ friendCode: user.friendCode, jobId });
          created++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `Failed to create idle update job for ${user.friendCode}: ${err}`,
          );
        }
      }

      // 2) 等待这一批所有 job 完成后再继续下一批
      if (batchJobIds.length > 0 && i + this.concurrency < users.length) {
        this.logger.debug(
          `Waiting for batch of ${batchJobIds.length} jobs to complete before next batch...`,
        );
        await this.waitForJobsToFinish(batchJobIds);
      }
    }

    this.logger.log(
      `Idle update complete: ${created} jobs created, ${failed} failed out of ${users.length} users`,
    );

    return { totalUsers: users.length, created, failed, entries };
  }

  /**
   * 轮询等待一组 job 全部进入终态 (completed / failed / canceled)
   */
  private async waitForJobsToFinish(jobIds: string[]): Promise<void> {
    const FINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);
    const pending = new Set(jobIds);
    const deadline = Date.now() + this.JOB_TIMEOUT_MS;

    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.POLL_INTERVAL_MS),
      );

      for (const jobId of [...pending]) {
        try {
          const job = await this.jobService.get(jobId);
          if (FINAL_STATUSES.has(job.status)) {
            pending.delete(jobId);
          }
        } catch {
          // job 查不到也视为完成
          pending.delete(jobId);
        }
      }
    }

    if (pending.size > 0) {
      this.logger.warn(
        `Timed out waiting for ${pending.size} jobs: ${[...pending].join(', ')}`,
      );
    }
  }
}
