import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JobEntity } from '../../job/schemas/job.schema';
import { BotStatusEntity } from '../schemas/bot-status.schema';
import { BotFriendSnapshotEntity } from '../schemas/bot-friend-snapshot.schema';

export interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
  friendCount: number | null;
  friendsUpdatedAt: string | null;
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

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @InjectModel(BotStatusEntity.name)
    private readonly botStatusModel: Model<BotStatusEntity>,
    @InjectModel(BotFriendSnapshotEntity.name)
    private readonly botFriendSnapshotModel: Model<BotFriendSnapshotEntity>,
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
  async report(
    bots: {
      friendCode: string;
      available: boolean;
      friendCount?: number;
      friendsUpdatedAt?: string;
    }[],
  ): Promise<void> {
    const now = new Date();

    // 查询上报前的 Bot 状态，用于保留本次未上报的派生字段
    const friendCodes = bots.map((b) => b.friendCode);
    const previousDocs = await this.botStatusModel
      .find({ friendCode: { $in: friendCodes } })
      .lean()
      .exec();
    const previousMap = new Map(previousDocs.map((d) => [d.friendCode, d]));

    // 执行 bulkWrite 更新状态
    const ops = bots.map((bot) => {
      const prev = previousMap.get(bot.friendCode);
      const friendsUpdatedAt = parseDateOrNull(bot.friendsUpdatedAt);

      return {
        updateOne: {
          filter: { friendCode: bot.friendCode },
          update: {
            $set: {
              available: bot.available,
              lastReportedAt: now,
              friendCount: bot.friendCount ?? prev?.friendCount ?? null,
              friendsUpdatedAt:
                friendsUpdatedAt ?? prev?.friendsUpdatedAt ?? null,
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
        friendsUpdatedAt: doc.friendsUpdatedAt
          ? new Date(doc.friendsUpdatedAt).toISOString()
          : null,
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
  async updateRemark(friendCode: string, remark: string | null): Promise<void> {
    await this.botStatusModel.updateOne({ friendCode }, { $set: { remark } });
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
   * Hard-remove a bot. No blacklist — if the worker is still alive
   * its next heartbeat will recreate the row. Mostly used to clean
   * up dead-cookie bots that clutter the admin UI.
   *
   * Side effects:
   *   - bot_friend_snapshots row also deleted (avoids stale data
   *     polluting QR-login reverse mapping)
   */
  async remove(friendCode: string): Promise<{
    botStatusDeleted: number;
    snapshotDeleted: number;
  }> {
    const [botRes, snapRes] = await Promise.all([
      this.botStatusModel.deleteOne({ friendCode }),
      this.botFriendSnapshotModel.deleteOne({ botFriendCode: friendCode }),
    ]);
    this.logger.log(
      `removed bot fc=${friendCode}: botStatus=${botRes.deletedCount}, snapshot=${snapRes.deletedCount}`,
    );
    return {
      botStatusDeleted: botRes.deletedCount ?? 0,
      snapshotDeleted: snapRes.deletedCount ?? 0,
    };
  }

  /**
   * Convenience: pick an available bot whose cabinetUserId is set, with
   * the lowest current friend-list load. Returns null if none qualifies.
   *
   * Only filters on `available` (worker is reporting in regularly) +
   * `cabinetUserId` (admin has configured the sdgb id).
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

    // worker 每 60s 才上报一次 friendCount，AutoUpdate sweep 一次能在
    // 几秒内连续触发 5-10 个 pick，那段时间所有 pick 看到的都是同一个
    // friendCount snapshot，永远选最小的那个 → 全堆同一个 bot 上。
    // 加上当前 queued/processing 的 in-flight job 数（这些 worker 还没
    // 上报为 friendCount 增量），让连续 pick 也能体现"刚刚分了一个"。
    const fcs = candidates.map((c) => c.friendCode);
    const inflightAgg = await this.jobModel
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            botUserFriendCode: { $in: fcs },
            status: { $in: ['queued', 'processing'] },
          },
        },
        { $group: { _id: '$botUserFriendCode', count: { $sum: 1 } } },
      ])
      .exec();
    const inflight = new Map(inflightAgg.map((r) => [r._id, r.count]));

    candidates.sort((a, b) => {
      const aLoad = (a.friendCount ?? 0) + (inflight.get(a.friendCode) ?? 0);
      const bLoad = (b.friendCount ?? 0) + (inflight.get(b.friendCode) ?? 0);
      return aLoad - bLoad;
    });
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

function parseDateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
