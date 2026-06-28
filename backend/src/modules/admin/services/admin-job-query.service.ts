import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { JobEntity } from '../../job/schemas/job.schema';
import type { ActiveJobsStats, SearchJobResult } from './admin.types';

@Injectable()
export class AdminJobQueryService {
  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
  ) {}

  async getActiveJobs(): Promise<ActiveJobsStats> {
    const now = Date.now();

    const [queuedCount, processingCount, jobs] = await Promise.all([
      this.jobModel.countDocuments({ status: 'queued' }),
      this.jobModel.countDocuments({ status: 'processing' }),
      this.jobModel
        .find({ status: { $in: ['queued', 'processing'] } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);

    return {
      queuedCount,
      processingCount,
      jobs: jobs.map((job) => ({
        id: job.id,
        friendCode: job.friendCode,
        jobType: job.jobType,
        botUserFriendCode: job.botUserFriendCode ?? null,
        status: job.status,
        stage: job.stage,
        scoreProgress: job.scoreProgress,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        runningDuration: now - job.createdAt.getTime(),
      })),
    };
  }

  async searchJobs(params: {
    friendCode?: string;
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    data: SearchJobResult[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const filter: Record<string, unknown> = {};

    if (params.friendCode) {
      filter.friendCode = params.friendCode;
    }

    const validStatuses = [
      'queued',
      'processing',
      'completed',
      'failed',
      'canceled',
    ];
    if (params.status && validStatuses.includes(params.status)) {
      filter.status = params.status;
    }

    const skip = (params.page - 1) * params.pageSize;

    const [jobs, total] = await Promise.all([
      this.jobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(params.pageSize)
        .lean(),
      this.jobModel.countDocuments(filter),
    ]);

    return {
      data: jobs.map((job) => {
        const raw = { ...(job as unknown as Record<string, unknown>) };
        delete raw._id;
        delete raw.__v;
        return {
          id: job.id,
          friendCode: job.friendCode,
          jobType: job.jobType,
          botUserFriendCode: job.botUserFriendCode ?? null,
          status: job.status,
          stage: job.stage,
          error: job.error ?? null,
          scoreProgress: job.scoreProgress ?? null,
          updateScoreDuration: job.updateScoreDuration ?? null,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          raw,
        };
      }),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }
}
