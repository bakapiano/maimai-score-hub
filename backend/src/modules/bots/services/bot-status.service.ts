import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { runMaintenanceWithLease } from '../../../common/redis/redis-lease.defaults';
import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import { JobEntity } from '../../job/schemas/job.schema';
import { BotStatusEntity } from '../schemas/bot-status.schema';
import { getDxnetWorkerQueueNames } from '@maimai-score-hub/shared';

export interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
  friendCount: number | null;
  friendsUpdatedAt: string | null;
  remark: string | null;
  cabinetUserId: number | null;
  workerId: string | null;
  revision: string | null;
  consumersReady: string[];
}

const DXNET_BOT_FRIEND_LIMIT = (() => {
  const parsed = Number(process.env.DXNET_BOT_FRIEND_LIMIT ?? 80);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 80;
})();
const DXNET_BOT_SOFT_FRIEND_LIMIT = 50;

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
    private readonly leases: RedisLeaseService,
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
      workerId?: string;
      revision?: string;
      consumersReady?: string[];
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
              workerId: bot.workerId ?? null,
              revision: bot.revision ?? null,
              consumersReady: bot.consumersReady ?? [],
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
        workerId: doc.workerId ?? null,
        revision: doc.revision ?? null,
        consumersReady: doc.consumersReady ?? [],
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

  async getByFriendCode(friendCode: string): Promise<BotStatus | null> {
    const rows = await this.getAll();
    return rows.find((row) => row.friendCode === friendCode) ?? null;
  }

  async getHealthyBots(
    allowlist: string[] | null,
    options: { cabinetRequired?: boolean } = {},
  ): Promise<BotStatus[]> {
    const cutoff = Date.now() - 90_000;
    return (await this.getAll()).filter(
      (bot) =>
        bot.available &&
        !!bot.workerId &&
        this.hasExpectedConsumers(bot) &&
        new Date(bot.lastReportedAt).getTime() >= cutoff &&
        (allowlist === null || allowlist.includes(bot.friendCode)) &&
        (!options.cabinetRequired || bot.cabinetUserId !== null),
    );
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
   * Side effects: embedded friend snapshot is deleted with the bot row.
   */
  async remove(friendCode: string): Promise<{
    botStatusDeleted: number;
  }> {
    const botRes = await this.botStatusModel.deleteOne({ friendCode });
    this.logger.log(
      `removed bot fc=${friendCode}: botStatus=${botRes.deletedCount}`,
    );
    return {
      botStatusDeleted: botRes.deletedCount ?? 0,
    };
  }

  /**
   * Convenience: pick an available bot whose cabinetUserId is set, with
   * the lowest current friend-list load. Returns null if none qualifies.
   *
   * Requires a fresh routing heartbeat, the exact six consumers, a cabinet
   * binding, and a fresh friend snapshot below the soft capacity limit.
   */
  async pickAvailableCabinetBot(
    options: {
      allowlist?: string[] | null;
    } = {},
  ): Promise<{
    friendCode: string;
    cabinetUserId: number;
  } | null> {
    const all = await this.getAll();
    const candidates = all.filter(
      (b) =>
        b.available &&
        this.matchesRoutingSelection(b, options) &&
        b.cabinetUserId !== null &&
        b.cabinetUserId !== undefined &&
        this.hasFreshFriendCapacity(b),
    );
    if (candidates.length === 0) {
      return null;
    }

    const [pick] = await this.sortByPickPriority(candidates);
    return { friendCode: pick.friendCode, cabinetUserId: pick.cabinetUserId! };
  }

  hasExpectedConsumers(
    bot: Pick<BotStatus, 'friendCode' | 'consumersReady'>,
  ): boolean {
    const expected = getDxnetWorkerQueueNames(bot.friendCode);
    const actual = new Set(bot.consumersReady);
    return (
      actual.size === expected.length &&
      expected.every((queueName) => actual.has(queueName))
    );
  }

  private hasFreshFriendCapacity(
    bot: Pick<BotStatus, 'friendCount' | 'friendsUpdatedAt'>,
  ): boolean {
    return (
      bot.friendCount !== null &&
      bot.friendCount < DXNET_BOT_SOFT_FRIEND_LIMIT &&
      !!bot.friendsUpdatedAt &&
      Date.now() - new Date(bot.friendsUpdatedAt).getTime() <= 5 * 60_000
    );
  }

  private matchesRoutingSelection(
    bot: BotStatus,
    options: {
      allowlist?: string[] | null;
    },
  ): boolean {
    return (
      !!bot.workerId &&
      this.hasExpectedConsumers(bot) &&
      Date.now() - new Date(bot.lastReportedAt).getTime() <= 90_000 &&
      (options.allowlist === undefined ||
        options.allowlist === null ||
        options.allowlist.includes(bot.friendCode))
    );
  }

  private async sortByPickPriority<
    T extends { friendCode: string; friendCount: number | null },
  >(candidates: T[]): Promise<T[]> {
    // Active queued/processing job count is the actual worker load. friendCount
    // is only a capacity signal, so it is used as a tie-breaker after load.
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
      const aJobLoad = inflight.get(a.friendCode) ?? 0;
      const bJobLoad = inflight.get(b.friendCode) ?? 0;
      if (aJobLoad !== bJobLoad) {
        return aJobLoad - bJobLoad;
      }

      const aFriendUsage = a.friendCount ?? DXNET_BOT_FRIEND_LIMIT;
      const bFriendUsage = b.friendCount ?? DXNET_BOT_FRIEND_LIMIT;
      return aFriendUsage - bFriendUsage;
    });
    return candidates;
  }

  /**
   * 启动定期清理定时器
   */
  private startCleanup(): void {
    this.cleanupIntervalId = setInterval(() => {
      this.runStaleCleanup().catch((err) => {
        this.logger.error('Failed to cleanup stale bot jobs', err);
      });
    }, BotStatusService.CLEANUP_INTERVAL_MS);
    this.logger.log(
      `Stale bot job cleanup started (interval: ${BotStatusService.CLEANUP_INTERVAL_MS}ms)`,
    );
  }

  private async runStaleCleanup(): Promise<void> {
    await runMaintenanceWithLease(
      this.leases,
      'bot-stale-job-cleanup',
      ({ signal }) => this.cleanupStaleJobs(signal),
    );
  }

  /**
   * 清理分配给不可用 Bot 的任务
   * 将 queued/processing 且分配给 5 分钟内未上报可用的 Bot 的任务标记为 failed
   */
  private async cleanupStaleJobs(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
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

    signal?.throwIfAborted();
    const claimResult = await this.jobModel.updateMany(
      {
        botUserFriendCode: { $in: unavailableBots },
        status: { $in: ['queued', 'processing'] },
        completionPending: { $ne: true },
        'routing.version': 2,
        'routing.assignmentMode': 'claim',
      },
      {
        $set: {
          status: 'queued',
          botUserFriendCode: null,
          'routing.deliveryMode': 'shared',
          execution: null,
          'cabinetFriendship.status': 'pending',
          'cabinetFriendship.botFriendCode': null,
          'cabinetFriendship.deliveryEpoch': null,
          'cabinetFriendship.attemptsStarted': null,
          'cabinetFriendship.sdgbJobId': null,
          'cabinetFriendship.lastError': null,
          runAt: null,
          updatedAt: new Date(),
        },
        $inc: { 'routing.deliveryEpoch': 1 },
      },
    );

    if (claimResult.modifiedCount > 0) {
      this.logger.warn(
        `Requeued ${claimResult.modifiedCount} claim jobs from unavailable bots: ${unavailableBots.join(', ')}`,
      );
    }
  }
}

function parseDateOrNull(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
