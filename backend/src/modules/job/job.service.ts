import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { SyncService } from '../sync/sync.service';
import { UsersService } from '../users/users.service';
import { JobTempCacheService } from './cache/temp-cache.service';
import type {
  JobPatchBody,
  JobResponse,
  JobStage,
  JobStatus,
  JobType,
} from './job.types';
import { JobEntity } from './job.schema';

export interface RecentJobStats {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  avgDuration: number | null;
}

const DEAD_JOB_TIMEOUT_MS = Number(
  process.env.DEAD_JOB_TIMEOUT_MS ?? 1 * 30 * 1000,
);

/** Queued jobs older than this are automatically failed (default: 5 min) */
const QUEUED_JOB_TIMEOUT_MS = Number(
  process.env.QUEUED_JOB_TIMEOUT_MS ?? 5 * 60 * 1000,
);

// [TODO] Change this to 1min
// const MIN_CREATE_INTERVAL_MS = Number(
//   process.env.MIN_CREATE_INTERVAL_MS ?? 1000 * 60,
// );

function toJobResponse(job: JobEntity): JobResponse {
  return {
    id: job.id,
    friendCode: job.friendCode,
    jobType: job.jobType ?? 'immediate',
    skipUpdateScore: job.skipUpdateScore,
    botUserFriendCode: job.botUserFriendCode ?? null,
    friendRequestSentAt: job.friendRequestSentAt ?? null,
    status: job.status,
    stage: job.stage,
    // result: job.result,
    profile: job.profile,
    scoreProgress: job.scoreProgress ?? null,
    updateScoreDuration: job.updateScoreDuration ?? null,
    autoExportResult: job.autoExportResult ?? null,
    isAuthenticated: job.isAuthenticated ?? false,
    error: job.error ?? null,
    executing: job.executing,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const VALID_STATUS: readonly JobStatus[] = [
  'queued',
  'processing',
  'completed',
  'canceled',
  'failed',
] as const;

const VALID_STAGE: readonly JobStage[] = [
  'send_request',
  'wait_acceptance',
  'update_score',
] as const;

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly syncService: SyncService,
    private readonly tempCacheService: JobTempCacheService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
  ) {}

  async create(input: {
    friendCode: string;
    skipUpdateScore: boolean;
    jobType?: JobType;
    botUserFriendCode?: string | null;
    isAuthenticated?: boolean;
    /**
     * Only meaningful when jobType=`idle_update_score`. Set by
     * AutoUpdateScheduler to the score hash it observed; propagates to
     * `user.lastScoreHash` only after this job completes successfully.
     */
    sourceScoreHash?: string | null;
  }) {
    const id = randomUUID();
    const now = new Date();
    const resolvedJobType: JobType = input.jobType ?? 'immediate';

    // [TODO] 将这个限流改为 ip 黑名单机制，同一时间对于一个 friend code 的请求如果过于频繁就拒绝
    // const recent = await this.jobModel
    //   .findOne({ friendCode: input.friendCode })
    //   .sort({ createdAt: -1 });
    // if (recent) {
    //   const diff = now.getTime() - recent.createdAt.getTime();
    //   if (diff < MIN_CREATE_INTERVAL_MS) {
    //     throw new BadRequestException('请求过于频繁，请等待一分钟过后重试！');
    //   }
    // }

    await this.jobModel.updateMany(
      {
        friendCode: input.friendCode,
        status: { $nin: ['completed', 'failed', 'canceled'] },
      },
      {
        $set: {
          status: 'canceled',
          executing: false,
          updatedAt: now,
        },
      },
    );

    const resolvedStage: 'send_request' | 'update_score' =
      resolvedJobType === 'idle_update_score' ? 'update_score' : 'send_request';

    const created = await this.jobModel.create({
      id,
      friendCode: input.friendCode,
      jobType: resolvedJobType,
      skipUpdateScore: input.skipUpdateScore,
      botUserFriendCode: input.botUserFriendCode ?? null,
      friendRequestSentAt: null,
      status: 'queued',
      stage: resolvedStage,
      executing: false,
      error: null,
      result: undefined,
      isAuthenticated: input.isAuthenticated ?? false,
      sourceScoreHash: input.sourceScoreHash ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return { jobId: id, job: toJobResponse(created.toObject() as JobEntity) };
  }

  async get(jobId: string): Promise<JobResponse> {
    const job = await this.jobModel.findOne({ id: jobId });
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    return toJobResponse(job.toObject() as JobEntity);
  }

  async claimNext(botUserFriendCode: string): Promise<JobResponse | null> {
    const now = new Date();

    // Release stale executing jobs before claiming.
    const staleThreshold = new Date(now.getTime() - DEAD_JOB_TIMEOUT_MS);
    await this.jobModel.updateMany(
      { executing: true, updatedAt: { $lte: staleThreshold } },
      { $set: { executing: false } },
    );

    // Fail queued jobs that have been waiting too long (unassigned only).
    const queuedDeadline = new Date(now.getTime() - QUEUED_JOB_TIMEOUT_MS);
    await this.jobModel.updateMany(
      {
        status: 'queued',
        botUserFriendCode: null,
        createdAt: { $lte: queuedDeadline },
      },
      {
        $set: {
          status: 'failed',
          error: '排队超时，可能是 Bot 繁忙或异常，请稍后再试',
          updatedAt: now,
        },
      },
    );

    // 1a) Queued first: claim the oldest unassigned queued job.
    //     To balance load across bots, only allow this bot to claim a new queued
    //     job if it doesn't already have more active jobs than any other bot.
    const activeCountForThisBot = await this.jobModel.countDocuments({
      botUserFriendCode,
      status: 'processing',
    });

    // Find the minimum active job count among all OTHER bots that have processing jobs.
    // If no other bots have any jobs, minOtherCount stays at Infinity and this bot can claim.
    const otherBotCounts = await this.jobModel.aggregate<{
      _id: string;
      count: number;
    }>([
      {
        $match: {
          status: 'processing',
          botUserFriendCode: { $ne: null, $nin: [botUserFriendCode] },
        },
      },
      { $group: { _id: '$botUserFriendCode', count: { $sum: 1 } } },
    ]);

    // When no other bots have processing jobs, skip the balance check entirely
    // so the only active bot is not artificially capped at 2.
    const shouldBalanceCheck = otherBotCounts.length > 0;
    const minOtherCount = shouldBalanceCheck
      ? Math.min(...otherBotCounts.map((b) => b.count))
      : 0;

    // Only claim new queued job if this bot's active count is not too far ahead of others.
    // Allow up to 1 more than the minimum, so a single bot going offline won't block others.
    // When this is the only active bot, skip the check entirely.
    if (!shouldBalanceCheck || activeCountForThisBot <= minOtherCount + 1) {
      // Find the oldest unassigned queued job
      const candidates = await this.jobModel
        .find({ status: 'queued', executing: false, botUserFriendCode: null })
        .sort({ updatedAt: 1 })
        .limit(10)
        .lean();

      for (const candidate of candidates) {
        // Check preferred bot: if job is queued < 30s and user prefers a different bot, skip
        const queuedDuration = now.getTime() - candidate.createdAt.getTime();
        if (queuedDuration < 30_000) {
          const preferredBot = await this.usersService.getPreferredBot(
            candidate.friendCode,
          );
          if (preferredBot && preferredBot !== botUserFriendCode) {
            continue; // Let the preferred bot pick this job
          }
        }

        // Try to atomically claim this job
        const claimed = await this.jobModel.findOneAndUpdate(
          {
            id: candidate.id,
            status: 'queued',
            executing: false,
            botUserFriendCode: null,
          },
          {
            $set: {
              status: 'processing',
              executing: true,
              botUserFriendCode,
              updatedAt: now,
            },
          },
          { new: true },
        );
        if (claimed) {
          return toJobResponse(claimed.toObject() as JobEntity);
        }
      }
    }

    // 1b) Resume: pick the oldest processing job for this bot.
    //     Only pick jobs whose updatedAt <= now (future updatedAt = intentional cooldown
    //     from wait_acceptance stage).
    const processing = await this.jobModel.findOneAndUpdate(
      {
        status: 'processing',
        botUserFriendCode,
        executing: false,
        updatedAt: { $lte: now },
      },
      {
        $set: {
          executing: true,
          updatedAt: now,
        },
      },
      { new: true, sort: { updatedAt: 1 } },
    );
    if (processing) {
      return toJobResponse(processing.toObject() as JobEntity);
    }

    // 2) Idle pool: claim pre-assigned queued jobs (e.g. idle_update_score)
    //    Lowest priority — only picked when no main pool jobs are available.
    const idle = await this.jobModel.findOneAndUpdate(
      { status: 'queued', executing: false, botUserFriendCode },
      {
        $set: {
          status: 'processing',
          executing: true,
          updatedAt: now,
        },
      },
      { new: true, sort: { createdAt: 1 } },
    );

    if (!idle) return null;
    return toJobResponse(idle.toObject() as JobEntity);
  }

  async patch(jobId: string, body: JobPatchBody): Promise<JobResponse> {
    const update: Partial<JobEntity> = {};
    const additionalOps: Record<string, unknown> = {};

    if (body.botUserFriendCode !== undefined) {
      if (
        body.botUserFriendCode !== null &&
        typeof body.botUserFriendCode !== 'string'
      ) {
        throw new BadRequestException(
          'botUserFriendCode must be a string or null',
        );
      }
      update.botUserFriendCode = body.botUserFriendCode;
    }

    if (body.status !== undefined) {
      if (!VALID_STATUS.includes(body.status)) {
        throw new BadRequestException('Invalid status value');
      }
      update.status = body.status;
    }

    if (body.stage !== undefined) {
      if (!VALID_STAGE.includes(body.stage)) {
        throw new BadRequestException('Invalid stage value');
      }
      update.stage = body.stage;
    }

    if (body.result !== undefined) {
      update.result = body.result;
    }

    if (body.profile !== undefined) {
      update.profile = body.profile;
    }

    if (body.error !== undefined) {
      if (body.error !== null && typeof body.error !== 'string') {
        throw new BadRequestException('error must be a string or null');
      }
      update.error = body.error;
    }

    if (body.friendRequestSentAt !== undefined) {
      if (
        body.friendRequestSentAt !== null &&
        typeof body.friendRequestSentAt !== 'string'
      ) {
        throw new BadRequestException(
          'friendRequestSentAt must be a string or null',
        );
      }
      update.friendRequestSentAt = body.friendRequestSentAt;
    }

    if (body.executing !== undefined) {
      if (typeof body.executing !== 'boolean') {
        throw new BadRequestException('executing must be a boolean');
      }
      update.executing = body.executing;
    }

    if (body.updatedAt !== undefined) {
      if (typeof body.updatedAt !== 'string') {
        throw new BadRequestException('updatedAt must be an ISO string');
      }
      const parsed = new Date(body.updatedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('updatedAt must be a valid ISO date');
      }
      update.updatedAt = parsed;
    } else {
      update.updatedAt = new Date();
    }

    // 处理 updateScoreDuration
    if (body.updateScoreDuration !== undefined) {
      if (
        body.updateScoreDuration !== null &&
        typeof body.updateScoreDuration !== 'number'
      ) {
        throw new BadRequestException(
          'updateScoreDuration must be a number or null',
        );
      }
      update.updateScoreDuration = body.updateScoreDuration;
    }

    // 处理 scoreProgress：完整替换模式
    if (body.scoreProgress !== undefined) {
      update.scoreProgress = body.scoreProgress;
    }

    // 处理 addCompletedDiff：原子追加模式（使用 $addToSet 避免并发冲突）
    if (body.addCompletedDiff !== undefined) {
      if (typeof body.addCompletedDiff !== 'number') {
        throw new BadRequestException('addCompletedDiff must be a number');
      }
      additionalOps.$addToSet = {
        'scoreProgress.completedDiffs': body.addCompletedDiff,
      };
    }

    // 构建更新操作
    const updateOps: Record<string, unknown> = {
      $set: update,
      ...additionalOps,
    };

    const updated = await this.jobModel.findOneAndUpdate(
      { id: jobId },
      updateOps,
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException('Job not found');
    }

    // 当 job 进入 wait_acceptance 或完成时，更新用户的偏好 bot
    if (
      updated.botUserFriendCode &&
      (body.stage === 'update_score' || body.status === 'completed')
    ) {
      this.usersService
        .updatePreferredBot(updated.friendCode, updated.botUserFriendCode)
        .catch((err) => {
          this.logger.error(
            `Failed to update preferred bot for ${updated.friendCode}: ${err?.message}`,
          );
        });
    }

    // 当 job 完成、失败或取消时，清理临时缓存
    const finalStatuses: JobStatus[] = ['completed', 'failed', 'canceled'];
    if (finalStatuses.includes(updated.status)) {
      // 异步清理缓存，不阻塞响应
      this.tempCacheService.deleteByJobId(jobId).catch((err) => {
        console.error(`Failed to delete temp cache for job ${jobId}:`, err);
      });
    }

    if (
      updated.status === 'completed' &&
      !updated.skipUpdateScore &&
      updated.result
    ) {
      await this.syncService.createFromJob(updated.toObject() as JobEntity);

      // Fire-and-forget auto-export
      this.runAutoExport(jobId, updated.friendCode).catch((err: Error) => {
        this.logger.error(
          `Auto-export failed for job ${jobId}: ${err?.message}`,
        );
      });
    }

    // Auto-update bookkeeping: when an idle_update_score job that was
    // launched by AutoUpdateScheduler completes successfully, promote
    // its sourceScoreHash onto the user's lastScoreHash. We deliberately
    // wait for completion so a failed/canceled job does not "burn" the
    // hash transition — the next sweep should see the same diff and try
    // again.
    if (
      updated.status === 'completed' &&
      updated.jobType === 'idle_update_score' &&
      updated.sourceScoreHash
    ) {
      this.usersService
        .findByFriendCode(updated.friendCode)
        .then((user) => {
          if (!user) return;
          return this.usersService.update(String(user._id), {
            lastScoreHash: updated.sourceScoreHash,
          });
        })
        .catch((err: Error) => {
          this.logger.warn(
            `Failed to promote sourceScoreHash for job ${jobId}: ${err?.message}`,
          );
        });
    }

    return toJobResponse(updated.toObject() as JobEntity);
  }

  async getActiveFriendCodesByBot(
    botUserFriendCode: string,
  ): Promise<string[]> {
    const jobs = await this.jobModel
      .find({
        botUserFriendCode,
        status: { $nin: ['completed', 'failed', 'canceled'] },
      })
      .select('friendCode')
      .lean();

    return jobs.map((job) => job.friendCode);
  }

  /**
   * 根据 friendCode 获取当前正在执行的任务（queued 或 processing 状态，且 skipUpdateScore 为 false）
   */
  async getActiveByFriendCode(friendCode: string): Promise<JobResponse | null> {
    const job = await this.jobModel
      .findOne({
        friendCode,
        skipUpdateScore: false,
        status: { $in: ['queued', 'processing'] },
      })
      .sort({ createdAt: -1 });

    if (!job) {
      return null;
    }

    return toJobResponse(job.toObject() as JobEntity);
  }

  async getRecentStats(): Promise<RecentJobStats> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const filter = {
      skipUpdateScore: false,
      createdAt: { $gte: oneHourAgo },
    };

    const [totalCount, completedCount, failedCount] = await Promise.all([
      this.jobModel.countDocuments(filter),
      this.jobModel.countDocuments({ ...filter, status: 'completed' }),
      this.jobModel.countDocuments({ ...filter, status: 'failed' }),
    ]);

    // 获取有 updateScoreDuration 的已完成任务的平均时长
    const durationStats = await this.jobModel.aggregate<{
      avgDuration: number;
    }>([
      {
        $match: {
          ...filter,
          status: 'completed',
          updateScoreDuration: { $ne: null, $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          avgDuration: { $avg: '$updateScoreDuration' },
        },
      },
    ]);

    const avgDuration = durationStats[0]
      ? Math.round(durationStats[0].avgDuration)
      : null;

    return {
      totalCount,
      completedCount,
      failedCount,
      successRate:
        totalCount > 0
          ? Math.round((completedCount / totalCount) * 10000) / 100
          : 0,
      avgDuration,
    };
  }

  /**
   * 检查指定 friendCode 是否已有活跃的闲时更新任务
   */
  async hasActiveIdleJob(friendCode: string): Promise<boolean> {
    const count = await this.jobModel.countDocuments({
      friendCode,
      jobType: { $in: ['idle_add_friend', 'idle_update_score'] },
      status: { $in: ['queued', 'processing'] },
    });
    return count > 0;
  }

  async getActiveIdleJob(friendCode: string) {
    const job = await this.jobModel
      .findOne({
        friendCode,
        jobType: { $in: ['idle_add_friend', 'idle_update_score'] },
        status: { $in: ['queued', 'processing'] },
      })
      .sort({ createdAt: -1 });
    if (!job) return null;
    return {
      id: job.id,
      jobType: job.jobType,
      status: job.status,
      stage: job.stage,
      scoreProgress: job.scoreProgress,
      friendRequestSentAt: job.friendRequestSentAt,
    };
  }

  /**
   * 清理创建时间在七天之前的所有 job
   */
  async cleanupOldJobs(): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.jobModel.deleteMany({
      createdAt: { $lt: sevenDaysAgo },
    });
    return result.deletedCount;
  }

  /**
   * 自动导出：检查用户设置，异步导出到 diving-fish / lxns，
   * 完成后将结果写回 job.autoExportResult
   */
  private async runAutoExport(
    jobId: string,
    friendCode: string,
  ): Promise<void> {
    const user = await this.usersService.findByFriendCode(friendCode);
    if (!user) return;

    const userDoc = user as unknown as Record<string, unknown>;
    const shouldExportDf =
      !!userDoc.autoExportDivingFish && !!user.divingFishImportToken;
    const shouldExportLxns = !!userDoc.autoExportLxns && !!user.lxnsImportToken;

    if (!shouldExportDf && !shouldExportLxns) return;

    const exportResult: {
      divingFish?: { status: string; message?: string } | null;
      lxns?: { status: string; message?: string } | null;
    } = {};

    if (shouldExportDf) {
      try {
        const res = await this.syncService.exportToDivingFish(
          friendCode,
          user.divingFishImportToken!,
        );
        exportResult.divingFish = {
          status: 'success',
          message: `导出 ${res.exported ?? 0} 条成绩`,
        };
        this.logger.log(`Auto-export to DivingFish succeeded for job ${jobId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        exportResult.divingFish = { status: 'failed', message: msg };
        this.logger.warn(
          `Auto-export to DivingFish failed for job ${jobId}: ${msg}`,
        );
      }
    }

    if (shouldExportLxns) {
      try {
        const res = await this.syncService.exportToLxns(
          friendCode,
          user.lxnsImportToken!,
        );
        exportResult.lxns = {
          status: 'success',
          message: `导出 ${res.exported ?? 0} 条成绩`,
        };
        this.logger.log(`Auto-export to LXNS succeeded for job ${jobId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        exportResult.lxns = { status: 'failed', message: msg };
        this.logger.warn(`Auto-export to LXNS failed for job ${jobId}: ${msg}`);
      }
    }

    // Write results back to the job document and the sync record
    await Promise.all([
      this.jobModel.updateOne(
        { id: jobId },
        { $set: { autoExportResult: exportResult } },
      ),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      this.syncService.updateAutoExportResult(jobId, exportResult),
    ]);
  }
}
