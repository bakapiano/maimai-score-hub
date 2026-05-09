import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JobEntity } from '../job/job.schema';
import { BotStatusEntity } from './bot-status.schema';
import { NotifyStateEntity } from './notify-state.schema';
import { FeishuNotifyService } from './feishu-notify.service';

export interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
  friendCount: number | null;
  remark: string | null;
  cabinetUserId: number | null;
}

/**
 * Bot 状态管理服务
 * 存储 Worker 上报的 Bot 可用性信息（MongoDB），并定期清理分配给不可用 Bot 的任务
 */
@Injectable()
export class BotStatusService implements OnModuleDestroy {
  private readonly logger = new Logger(BotStatusService.name);

  /** 定期清理不可用 Bot 任务的定时器 */
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  /** 清理间隔 (ms) - 5 分钟 */
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  /** Bot 上报超时阈值 (ms) - 5 分钟未上报视为不可用 */
  private static readonly REPORT_TIMEOUT_MS = 5 * 60 * 1000;

  /** "所有 Bot 均不可用" 通知状态在 MongoDB 中的 key */
  private static readonly ALL_BOTS_DOWN_KEY = 'all_bots_down';

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @InjectModel(BotStatusEntity.name)
    private readonly botStatusModel: Model<BotStatusEntity>,
    @InjectModel(NotifyStateEntity.name)
    private readonly notifyStateModel: Model<NotifyStateEntity>,
    private readonly feishuNotify: FeishuNotifyService,
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
   * 检测状态变化并触发飞书通知
   */
  async report(
    bots: { friendCode: string; available: boolean; friendCount?: number }[],
  ): Promise<void> {
    const now = new Date();

    // 查询上报前的 Bot 状态，用于检测变化
    const friendCodes = bots.map((b) => b.friendCode);
    const previousDocs = await this.botStatusModel
      .find({ friendCode: { $in: friendCodes } })
      .lean()
      .exec();
    const previousMap = new Map(previousDocs.map((d) => [d.friendCode, d]));

    // 执行 bulkWrite 更新状态
    const ops = bots.map((bot) => {
      const prev = previousMap.get(bot.friendCode);
      const wasAvailable = prev?.available ?? true;
      const nowAvailable = bot.available;

      // 计算 notifiedUnavailable 标记：
      // - 从可用变为不可用：保持当前值（稍后通知逻辑会更新）
      // - 从不可用恢复可用：重置为 false（以便下次不可用时重新通知）
      const notifiedUpdate =
        !wasAvailable && nowAvailable ? { notifiedUnavailable: false } : {};

      return {
        updateOne: {
          filter: { friendCode: bot.friendCode },
          update: {
            $set: {
              available: bot.available,
              lastReportedAt: now,
              friendCount: bot.friendCount ?? null,
              // Worker reported friends → satisfies any pending refresh
              // request for this bot.
              ...(bot.friendCount !== undefined
                ? { friendListRefreshRequestedAt: null }
                : {}),
              ...notifiedUpdate,
            },
          },
          upsert: true,
        },
      };
    });

    await this.botStatusModel.bulkWrite(ops);

    this.logger.log(
      `Bot status reported: ${bots.length} bots (${bots.filter((b) => b.available).length} available)`,
    );

    // 检测新变为不可用的 Bot，使用原子操作避免多实例重复通知
    const candidateFriendCodes = bots
      .filter((bot) => {
        if (bot.available) return false;
        const prev = previousMap.get(bot.friendCode);
        return !prev || prev.available || !prev.notifiedUnavailable;
      })
      .map((b) => b.friendCode);

    if (candidateFriendCodes.length > 0) {
      await this.notifyNewlyUnavailableBots(candidateFriendCodes, previousMap);
    }

    // 恢复可用的 Bot：重置 notifiedUnavailable 标记并发送恢复通知
    const recoveredBots = bots.filter((bot) => {
      if (!bot.available) return false;
      const prev = previousMap.get(bot.friendCode);
      return prev && !prev.available;
    });

    if (recoveredBots.length > 0) {
      const recoveredFriendCodes = recoveredBots.map((b) => b.friendCode);
      await this.botStatusModel.updateMany(
        { friendCode: { $in: recoveredFriendCodes } },
        { $set: { notifiedUnavailable: false } },
      );

      // 发送恢复通知
      const alertBots = recoveredBots.map((b) => ({
        friendCode: b.friendCode,
        remark: previousMap.get(b.friendCode)?.remark ?? null,
      }));
      await this.feishuNotify.sendBotRecoveredAlert(alertBots);
    }

    // 检查是否所有 Bot 均不可用（原子操作）
    await this.checkAllBotsDown();
  }

  /**
   * 获取所有 Bot 的状态
   */
  async getAll(): Promise<BotStatus[]> {
    const now = Date.now();
    const docs = await this.botStatusModel.find().lean().exec();

    return docs.map((doc) => {
      const timeSinceReport = now - new Date(doc.lastReportedAt).getTime();
      const timedOut = timeSinceReport > BotStatusService.REPORT_TIMEOUT_MS;

      return {
        friendCode: doc.friendCode,
        available: timedOut ? false : doc.available,
        lastReportedAt: new Date(doc.lastReportedAt).toISOString(),
        friendCount: doc.friendCount,
        remark: doc.remark ?? null,
        cabinetUserId: doc.cabinetUserId ?? null,
      };
    });
  }

  /**
   * 获取指定 bot 的好友数量
   */
  async getFriendCount(friendCode: string): Promise<number | null> {
    const doc = await this.botStatusModel.findOne({ friendCode }).lean().exec();
    return doc?.friendCount ?? null;
  }

  /**
   * 更新指定 bot 的备注
   */
  async updateRemark(
    friendCode: string,
    remark: string | null,
  ): Promise<void> {
    await this.botStatusModel.updateOne(
      { friendCode },
      { $set: { remark } },
    );
  }

  /**
   * Set the cabinet (sdgb) userId for a bot. Used as `userId1` of
   * UserFriendRegistApi when the auto-update flow needs the bot to add a
   * user as a rival on the cabinet side.
   */
  async setCabinetUserId(
    friendCode: string,
    cabinetUserId: number | null,
  ): Promise<void> {
    await this.botStatusModel.updateOne(
      { friendCode },
      { $set: { cabinetUserId } },
    );
  }

  /**
   * Mark a bot's friend list as needing an out-of-band refresh. The worker
   * polls `getRefreshRequests()` every few seconds; when it sees this bot,
   * it pulls + reports the friend list immediately, bypassing the 5-min
   * tick. Used by QR-login after addRival to shrink the "wait for snapshot"
   * window from ~60s down to ~15-20s.
   */
  async requestFriendListRefresh(friendCode: string): Promise<void> {
    await this.botStatusModel.updateOne(
      { friendCode },
      { $set: { friendListRefreshRequestedAt: new Date() } },
    );
  }

  /**
   * Worker pull: which bots are awaiting a refresh. Returns just the
   * friendCodes; the worker calls report afterwards which clears the flag.
   */
  async getRefreshRequests(): Promise<string[]> {
    const docs = await this.botStatusModel
      .find({ friendListRefreshRequestedAt: { $ne: null } })
      .select({ friendCode: 1 })
      .lean();
    return docs.map((d) => d.friendCode);
  }

  /**
   * Clear the refresh flag once the worker has actually re-reported the
   * friend list. We clear conditionally on "stamp earlier than now" so
   * a refresh request landing AFTER the worker started fetching but
   * before it finished isn't accidentally swallowed.
   */
  async clearRefreshRequest(friendCode: string, asOf: Date): Promise<void> {
    await this.botStatusModel.updateOne(
      {
        friendCode,
        friendListRefreshRequestedAt: { $lte: asOf },
      },
      { $set: { friendListRefreshRequestedAt: null } },
    );
  }

  /**
   * Convenience: pick an available bot whose cabinetUserId is set, with
   * the lowest current idle-update load. Returns null if none qualifies.
   */
  async pickAvailableCabinetBot(): Promise<{
    friendCode: string;
    cabinetUserId: number;
  } | null> {
    const all = await this.getAll();
    const candidates = all.filter(
      (b) => b.available && b.cabinetUserId != null,
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.friendCount ?? 0) - (b.friendCount ?? 0));
    const pick = candidates[0];
    return { friendCode: pick.friendCode, cabinetUserId: pick.cabinetUserId! };
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
   * 同时检测超时未上报的 Bot 并触发飞书通知
   */
  private async cleanupStaleJobs(): Promise<void> {
    const now = Date.now();
    const threshold = new Date(now - BotStatusService.REPORT_TIMEOUT_MS);

    // 从 DB 查询不可用的 bot
    const unavailableDocs = await this.botStatusModel
      .find({
        $or: [{ available: false }, { lastReportedAt: { $lt: threshold } }],
      })
      .lean()
      .exec();

    const unavailableBots = unavailableDocs.map((d) => d.friendCode);

    if (!unavailableBots.length) {
      return;
    }

    // 检测超时未上报且尚未通知过的 Bot，使用原子操作触发飞书通知
    const unnotifiedFriendCodes = unavailableDocs
      .filter((d) => !d.notifiedUnavailable)
      .map((d) => d.friendCode);

    if (unnotifiedFriendCodes.length > 0) {
      const remarkMap = new Map(
        unavailableDocs.map((d) => [d.friendCode, d.remark ?? null]),
      );
      await this.notifyNewlyUnavailableBots(unnotifiedFriendCodes, remarkMap);
    }

    // 检查是否所有 Bot 均不可用（原子操作）
    await this.checkAllBotsDown();

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

  /**
   * 原子地标记 Bot 为已通知，并发送飞书告警
   * 使用 MongoDB 原子操作 `notifiedUnavailable: false` 作为 filter 条件，
   * 只有成功将 false→true 的实例才发送通知，避免多实例重复发送
   */
  private async notifyNewlyUnavailableBots(
    friendCodes: string[],
    remarkSource: Map<string, string | null | { remark?: string | null }>,
  ): Promise<void> {
    // 原子地将 notifiedUnavailable 从 false 改为 true
    // 只有未被其他实例抢先标记的 Bot 会被匹配到
    const claimResult = await this.botStatusModel.updateMany(
      {
        friendCode: { $in: friendCodes },
        notifiedUnavailable: { $ne: true },
      },
      { $set: { notifiedUnavailable: true } },
    );

    if (claimResult.modifiedCount === 0) return;

    // 查询刚被标记的 Bot 信息（它们现在 notifiedUnavailable: true）
    const claimedDocs = await this.botStatusModel
      .find({
        friendCode: { $in: friendCodes },
        notifiedUnavailable: true,
        available: false,
      })
      .lean()
      .exec();

    // 使用实际 DB 中的 remark，保证信息准确
    const alertBots = claimedDocs.map((d) => ({
      friendCode: d.friendCode,
      remark: d.remark ?? null,
    }));

    if (alertBots.length > 0) {
      // 查询当前仍可用的 Bot 数量
      const remainingAvailable = await this.botStatusModel.countDocuments({
        available: true,
      });
      await this.feishuNotify.sendBotUnavailableAlert(
        alertBots,
        remainingAvailable,
      );
    }
  }

  /**
   * 原子地检查并发送"所有 Bot 均不可用"告警
   * 使用 MongoDB findOneAndUpdate 原子操作，确保多实例只发送一次
   */
  private async checkAllBotsDown(): Promise<void> {
    const now = Date.now();
    const threshold = new Date(now - BotStatusService.REPORT_TIMEOUT_MS);

    const allBotDocs = await this.botStatusModel.find().lean().exec();
    if (allBotDocs.length === 0) return;

    const allUnavailable = allBotDocs.every(
      (d) =>
        !d.available ||
        new Date(d.lastReportedAt).getTime() < threshold.getTime(),
    );

    if (allUnavailable) {
      // 原子地将 notified 从 false 改为 true，只有一个实例能成功
      const claimed = await this.notifyStateModel.findOneAndUpdate(
        {
          key: BotStatusService.ALL_BOTS_DOWN_KEY,
          notified: false,
        },
        {
          $set: { notified: true, lastNotifiedAt: new Date() },
        },
      );

      // 如果没有匹配到文档（首次运行或已被其他实例抢先），尝试 upsert
      if (!claimed) {
        // 用 upsert 确保文档存在，但只在 notified 为 false 时才更新
        const upsertResult = await this.notifyStateModel.updateOne(
          { key: BotStatusService.ALL_BOTS_DOWN_KEY },
          {
            $setOnInsert: {
              notified: true,
              lastNotifiedAt: new Date(),
            },
          },
          { upsert: true },
        );

        // upsertedCount > 0 说明是新插入的，这个实例赢得了通知权
        if (upsertResult.upsertedCount === 0) return;
      }

      await this.feishuNotify.sendAllBotsDownAlert(
        allBotDocs.map((d) => ({
          friendCode: d.friendCode,
          remark: d.remark ?? null,
        })),
      );
    } else {
      // 有 Bot 恢复可用，重置通知状态（允许下次再告警）
      await this.notifyStateModel.updateOne(
        { key: BotStatusService.ALL_BOTS_DOWN_KEY },
        { $set: { notified: false } },
        { upsert: true },
      );
    }
  }
}
