import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import type { JobResponse, JobStage, JobStatus } from './job.types';
import { JobEntity } from './job.schema';

function toJobResponse(job: JobEntity): JobResponse {
  return {
    id: job.id,
    friendCode: job.friendCode,
    skipUpdateScore: job.skipUpdateScore,
    botUserFriendCode: job.botUserFriendCode ?? null,
    status: job.status,
    stage: job.stage,
    result: job.result,
    error: job.error ?? null,
    executing: job.executing,
    retryCount: job.retryCount,
    nextRetryAt: job.nextRetryAt ? job.nextRetryAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const VALID_STATUS: readonly JobStatus[] = [
  'queued',
  'processing',
  'completed',
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
  ) {}

  async create(input: { friendCode: string; skipUpdateScore: boolean }) {
    const id = randomUUID();
    const now = new Date();

    const created = await this.jobModel.create({
      id,
      friendCode: input.friendCode,
      skipUpdateScore: input.skipUpdateScore,
      botUserFriendCode: null,
      status: 'queued',
      stage: 'send_request',
      retryCount: 0,
      executing: false,
      nextRetryAt: null,
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

  async claimNext(): Promise<JobResponse | null> {
    const now = new Date();

    // Atomic claim with sort by oldest createdAt.
    const query: any = {
      $and: [
        { status: { $in: ['queued', 'processing'] } },
        { $or: [{ executing: false }, { executing: { $exists: false } }] },
        {
          $or: [
            { nextRetryAt: null },
            { nextRetryAt: { $exists: false } },
            { nextRetryAt: { $lte: now } },
          ],
        },
      ],
    };

    const updatePipeline: any = [
      {
        $set: {
          executing: true,
          updatedAt: now,
          status: {
            $cond: [{ $eq: ['$status', 'queued'] }, 'processing', '$status'],
          },
          stage: {
            $cond: [{ $eq: ['$status', 'queued'] }, 'send_request', '$stage'],
          },
        },
      },
    ];

    const claimed = await this.jobModel.findOneAndUpdate(query, updatePipeline, {
      sort: { createdAt: 1 },
      new: true,
      updatePipeline: true,
    });

    if (!claimed) {
      return null;
    }

    return toJobResponse(claimed.toObject() as JobEntity);
  }

  async patch(jobId: string, body: any): Promise<JobResponse> {
    const update: Partial<JobEntity> = {};

    if (body.botUserFriendCode !== undefined) {
      if (body.botUserFriendCode !== null && typeof body.botUserFriendCode !== 'string') {
        throw new BadRequestException('botUserFriendCode must be a string or null');
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

    if (body.error !== undefined) {
      if (body.error !== null && typeof body.error !== 'string') {
        throw new BadRequestException('error must be a string or null');
      }
      update.error = body.error;
    }

    if (body.executing !== undefined) {
      if (typeof body.executing !== 'boolean') {
        throw new BadRequestException('executing must be a boolean');
      }
      update.executing = body.executing;
    }

    if (body.retryCount !== undefined) {
      if (typeof body.retryCount !== 'number' || Number.isNaN(body.retryCount)) {
        throw new BadRequestException('retryCount must be a number');
      }
      update.retryCount = body.retryCount;
    }

    if (body.nextRetryAt !== undefined) {
      if (body.nextRetryAt === null) {
        update.nextRetryAt = null;
      } else if (typeof body.nextRetryAt === 'string') {
        const parsed = new Date(body.nextRetryAt);
        if (Number.isNaN(parsed.getTime())) {
          throw new BadRequestException('nextRetryAt must be a valid ISO date');
        }
        update.nextRetryAt = parsed;
      } else {
        throw new BadRequestException('nextRetryAt must be null or ISO string');
      }
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

    const updated = await this.jobModel.findOneAndUpdate(
      { id: jobId },
      { $set: update },
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException('Job not found');
    }

    return toJobResponse(updated.toObject() as JobEntity);
  }
}
