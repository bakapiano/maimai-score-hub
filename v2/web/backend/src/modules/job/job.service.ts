import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { SyncService } from '../sync/sync.service';
import type { JobResponse, JobStage, JobStatus } from './job.types';
import { JobEntity } from './job.schema';

const DEAD_JOB_TIMEOUT_MS = Number(
  process.env.DEAD_JOB_TIMEOUT_MS ?? 1 * 60 * 1000,
);

// [TODO] Change this to 1min
const MIN_CREATE_INTERVAL_MS = Number(
  process.env.MIN_CREATE_INTERVAL_MS ?? 1000 * 60,
);

function toJobResponse(job: JobEntity): JobResponse {
  return {
    id: job.id,
    friendCode: job.friendCode,
    skipUpdateScore: job.skipUpdateScore,
    botUserFriendCode: job.botUserFriendCode ?? null,
    friendRequestSentAt: job.friendRequestSentAt ?? null,
    status: job.status,
    stage: job.stage,
    result: job.result,
    profile: job.profile,
    scoreProgress: job.scoreProgress ?? null,
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
  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly syncService: SyncService,
  ) {}

  async create(input: { friendCode: string; skipUpdateScore: boolean }) {
    const id = randomUUID();
    const now = new Date();

    const recent = await this.jobModel
      .findOne({ friendCode: input.friendCode })
      .sort({ createdAt: -1 });
    if (recent) {
      const diff = now.getTime() - recent.createdAt.getTime();
      if (diff < MIN_CREATE_INTERVAL_MS) {
        throw new BadRequestException(
          'Too many requests for this friendCode; please wait a minute.',
        );
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

    const created = await this.jobModel.create({
      id,
      friendCode: input.friendCode,
      skipUpdateScore: input.skipUpdateScore,
      botUserFriendCode: null,
      friendRequestSentAt: null,
      status: 'queued',
      stage: 'send_request',
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

    // 2) Claim the oldest queued job atomically via findOneAndUpdate
    const claimed = await this.jobModel.findOneAndUpdate(
      { status: 'queued', executing: false },
      {
        $set: {
          status: 'processing',
          stage: 'send_request',
          executing: true,
          botUserFriendCode,
          updatedAt: now,
        },
      },
      { new: true, sort: { createdAt: 1 } },
    );

    if (!claimed) return null;
    return toJobResponse(claimed.toObject() as JobEntity);
  }

  async patch(jobId: string, body: any): Promise<JobResponse> {
    const update: Partial<JobEntity> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const additionalOps: Record<string, any> = {};

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

    if (
      updated.status === 'completed' &&
      !updated.skipUpdateScore &&
      updated.result
    ) {
      await this.syncService.createFromJob(updated.toObject() as JobEntity);
    }

    return toJobResponse(updated.toObject() as JobEntity);
  }
}
