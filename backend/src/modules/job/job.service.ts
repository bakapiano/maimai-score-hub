import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { SyncService } from '../sync/sync.service';
import { JobTempCacheService } from './job-temp-cache.service';
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

// [TODO] Change this to 1min
const MIN_CREATE_INTERVAL_MS = Number(
  process.env.MIN_CREATE_INTERVAL_MS ?? 1000 * 60,
);

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
    error: job.error ?? null,
    executing: job.executing,
    pickedAt: job.pickedAt?.toISOString() ?? null,
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
  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly syncService: SyncService,
    private readonly tempCacheService: JobTempCacheService,
  ) {}

  async create(input: {
    friendCode: string;
    skipUpdateScore: boolean;
    jobType?: JobType;
    botUserFriendCode?: string | null;
  }) {
    const id = randomUUID();
    const now = new Date();
    const resolvedJobType: JobType = input.jobType ?? 'immediate';

    const recent = await this.jobModel
      .findOne({ friendCode: input.friendCode })
      .sort({ createdAt: -1 });
    if (recent) {
      const diff = now.getTime() - recent.createdAt.getTime();
      if (diff < MIN_CREATE_INTERVAL_MS) {
        throw new BadRequestException('请求过于频繁，请等待一分钟过后重试！');
      }
    }

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

    // 1) Prefer already-processing job for this bot
    const processing = await this.jobModel.findOneAndUpdate(
      { status: 'processing', botUserFriendCode, executing: false },
      { $set: { executing: true, updatedAt: now } },
      { new: true, sort: { createdAt: 1 } },
    );
    if (processing) {
      return toJobResponse(processing.toObject() as JobEntity);
    }

    // 2) Claim queued jobs that are pre-assigned to this bot
    //    (e.g. idle_update_score jobs locked to a specific bot)
    const preAssigned = await this.jobModel.findOneAndUpdate(
      { status: 'queued', executing: false, botUserFriendCode },
      {
        $set: {
          status: 'processing',
          executing: true,
          pickedAt: now,
          updatedAt: now,
        },
      },
      { new: true, sort: { createdAt: 1 } },
    );
    if (preAssigned) {
      return toJobResponse(preAssigned.toObject() as JobEntity);
    }

    // 3) Claim the oldest unassigned queued job atomically via findOneAndUpdate
    //    Don't overwrite `stage` — it was already set correctly at creation
    //    (e.g. idle_update_score starts at 'update_score').
    const claimed = await this.jobModel.findOneAndUpdate(
      { status: 'queued', executing: false, botUserFriendCode: null },
      {
        $set: {
          status: 'processing',
          executing: true,
          botUserFriendCode,
          pickedAt: now,
          updatedAt: now,
        },
      },
      { new: true, sort: { createdAt: 1 } },
    );

    if (!claimed) return null;
    return toJobResponse(claimed.toObject() as JobEntity);
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
      $or: [
        { jobType: 'immediate' },
        { jobType: { $exists: false } },
        { jobType: null },
      ],
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
      pickedAt: job.pickedAt,
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
}
