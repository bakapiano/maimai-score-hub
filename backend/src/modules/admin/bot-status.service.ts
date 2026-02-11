import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JobEntity } from '../job/job.schema';

export interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
  friendCount: number | null;
}

/**
 * Bot 状态管理服务
 * 存储 Worker 上报的 Bot 可用性信息，并定期清理分配给不可用 Bot 的任务
 */
@Injectable()
export class BotStatusService implements OnModuleDestroy {
  private readonly logger = new Logger(BotStatusService.name);

  /** Bot 状态: friendCode -> { available, lastReportedAt, friendCount } */
  private readonly botMap = new Map<
    string,
    { available: boolean; lastReportedAt: Date; friendCount: number | null }
  >();

  /** 定期清理不可用 Bot 任务的定时器 */
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  /** 清理间隔 (ms) - 5 分钟 */
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  /** Bot 上报超时阈值 (ms) - 5 分钟未上报视为不可用 */
  private static readonly REPORT_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
  ) {
    this.startCleanup();
  }

  onModuleDestroy() {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Worker 上报 Bot 状态
   */
  report(
    bots: { friendCode: string; available: boolean; friendCount?: number }[],
  ): void {
    const now = new Date();
    for (const bot of bots) {
      this.botMap.set(bot.friendCode, {
        available: bot.available,
        lastReportedAt: now,
        friendCount: bot.friendCount ?? null,
      });
    }
    this.logger.log(
      `Bot status reported: ${bots.length} bots (${bots.filter((b) => b.available).length} available)`,
    );
  }

  /**
   * 获取所有 Bot 的状态
   */
  getAll(): BotStatus[] {
    const now = Date.now();
    const result: BotStatus[] = [];

    for (const [friendCode, status] of this.botMap) {
      const timeSinceReport = now - status.lastReportedAt.getTime();
      const timedOut = timeSinceReport > BotStatusService.REPORT_TIMEOUT_MS;

      result.push({
        friendCode,
        available: timedOut ? false : status.available,
        lastReportedAt: status.lastReportedAt.toISOString(),
        friendCount: status.friendCount,
      });
    }

    return result;
  }

  /**
   * 获取指定 bot 的好友数量
   */
  getFriendCount(friendCode: string): number | null {
    const status = this.botMap.get(friendCode);
    return status?.friendCount ?? null;
  }

  /**
   * 启动定期清理定时器
   */
  private startCleanup(): void {
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupStaleJobs().catch((err) => {
        this.logger.error('Failed to cleanup stale bot jobs', err);
      });
    }, BotStatusService.CLEANUP_INTERVAL_MS);
    this.logger.log(
      `Stale bot job cleanup started (interval: ${BotStatusService.CLEANUP_INTERVAL_MS}ms)`,
    );
  }

  /**
   * 清理分配给不可用 Bot 的任务
   * 将 queued/processing 且分配给 5 分钟内未上报可用的 Bot 的任务标记为 failed
   */
  private async cleanupStaleJobs(): Promise<void> {
    const now = Date.now();
    const unavailableBots: string[] = [];

    for (const [friendCode, status] of this.botMap) {
      const timeSinceReport = now - status.lastReportedAt.getTime();
      if (
        !status.available ||
        timeSinceReport > BotStatusService.REPORT_TIMEOUT_MS
      ) {
        unavailableBots.push(friendCode);
      }
    }

    if (!unavailableBots.length) {
      return;
    }

    const result = await this.jobModel.updateMany(
      {
        botUserFriendCode: { $in: unavailableBots },
        status: { $in: ['queued', 'processing'] },
      },
      {
        $set: {
          status: 'failed',
          executing: false,
          error: 'Bot Cookie 已过期或不可用',
          updatedAt: new Date(),
        },
      },
    );

    if (result.modifiedCount > 0) {
      this.logger.warn(
        `Cleaned up ${result.modifiedCount} jobs assigned to unavailable bots: ${unavailableBots.join(', ')}`,
      );
    }
  }
}
