import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  SDGB_JOB_TYPES_BY_LANE,
  type SdgbJobType,
} from '@maimai-score-hub/shared';
import type { Model } from 'mongoose';

import {
  SdgbJobEntity,
  type SdgbJobDocument,
  type SdgbJobStatus,
} from '../schemas/sdgb-job.schema';
import {
  escapeRegex,
  roleForCapabilities,
  secondsSince,
  toSdgbAdminView,
  type SdgbAdminStatusView,
  type SdgbJobListOptions,
  type SdgbJobListView,
} from './sdgb-job.view';
import { SdgbWorkerRegistryService } from './sdgb-worker-registry.service';

const WORKER_STALE_MS = Number(process.env.SDGB_WORKER_STALE_MS ?? 30 * 1000);
const RECENT_JOB_LIMIT = 20;
const SDGB_JOB_TYPES: SdgbJobType[] = [
  'scan_qr',
  'get_rival_hash',
  'get_user_map',
  'add_rival',
  'get_music_score',
];

@Injectable()
export class SdgbJobAdminQueryService {
  constructor(
    @InjectModel(SdgbJobEntity.name)
    private readonly model: Model<SdgbJobDocument>,
    private readonly registry: SdgbWorkerRegistryService,
  ) {}

  async getStatus(): Promise<SdgbAdminStatusView> {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const oneHourAgo = new Date(nowMs - 60 * 60 * 1000);
    const [
      workers,
      queueCounts,
      byTypeCounts,
      oldestQueued,
      oldestProcessing,
      recent,
    ] = await Promise.all([
      this.registry.listWorkers(),
      this.statusCounts(),
      this.typeCounts(oneHourAgo),
      this.model
        .findOne({ status: 'queued' })
        .sort({ createdAt: 1 })
        .lean<SdgbJobEntity>(),
      this.model
        .findOne({ status: 'processing' })
        .sort({ claimedAt: 1, updatedAt: 1 })
        .lean<SdgbJobEntity>(),
      this.model
        .find()
        .sort({ updatedAt: -1 })
        .limit(RECENT_JOB_LIMIT)
        .lean<SdgbJobEntity[]>(),
    ]);
    const queue = this.queueSummary(queueCounts);
    const byType = this.typeSummary(byTypeCounts);
    return {
      workers: workers.map((worker) => {
        const lastSeenAt = new Date(worker.lastSeenAt);
        return {
          workerId: worker.workerId,
          workerClass: worker.workerClass,
          role: roleForCapabilities(worker.capabilities),
          lanes: worker.capabilities,
          jobTypes: worker.capabilities.flatMap(
            (lane) => SDGB_JOB_TYPES_BY_LANE[lane],
          ),
          laneMemberships: worker.laneMemberships,
          lastSeenAt: lastSeenAt.toISOString(),
          ageSeconds: secondsSince(lastSeenAt, nowMs) ?? 0,
          jobsClaimed: worker.jobsClaimed,
          alive: now.getTime() - lastSeenAt.getTime() <= WORKER_STALE_MS,
        };
      }),
      queue,
      byType,
      oldestQueuedAgeSeconds: secondsSince(oldestQueued?.createdAt, nowMs),
      oldestProcessingAgeSeconds: secondsSince(
        oldestProcessing?.claimedAt ?? oldestProcessing?.updatedAt,
        nowMs,
      ),
      recentJobs: recent.map((job) => toSdgbAdminView(job, nowMs)),
    };
  }

  async list(opts: SdgbJobListOptions): Promise<SdgbJobListView> {
    const page = Math.max(1, opts.page);
    const pageSize = Math.min(200, Math.max(1, opts.pageSize));
    const filter: Record<string, unknown> = {};
    if (opts.jobType) {
      filter.jobType = opts.jobType;
    }
    if (opts.status) {
      filter.status = opts.status;
    }
    if (opts.tag) {
      filter.requesterTag = { $regex: escapeRegex(opts.tag), $options: 'i' };
    }
    const [total, docs] = await Promise.all([
      this.model.countDocuments(filter),
      this.model
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean<SdgbJobEntity[]>(),
    ]);
    const nowMs = Date.now();
    return {
      items: docs.map((job) => toSdgbAdminView(job, nowMs)),
      total,
      page,
      pageSize,
    };
  }

  private async statusCounts(): Promise<
    Array<readonly [SdgbJobStatus, number]>
  > {
    return Promise.all(
      (['queued', 'processing', 'completed', 'failed'] as SdgbJobStatus[]).map(
        async (status) =>
          [status, await this.model.countDocuments({ status })] as const,
      ),
    );
  }

  private typeCounts(oneHourAgo: Date) {
    return this.model
      .aggregate<{
        _id: { jobType: SdgbJobType; status: SdgbJobStatus };
        count: number;
      }>([
        {
          $match: {
            jobType: { $in: SDGB_JOB_TYPES },
            $or: [
              { status: { $in: ['queued', 'processing'] } },
              {
                status: { $in: ['completed', 'failed'] },
                updatedAt: { $gte: oneHourAgo },
              },
            ],
          },
        },
        {
          $group: {
            _id: { jobType: '$jobType', status: '$status' },
            count: { $sum: 1 },
          },
        },
      ])
      .exec();
  }

  private queueSummary(
    counts: Array<readonly [SdgbJobStatus, number]>,
  ): Record<SdgbJobStatus, number> {
    const queue: Record<SdgbJobStatus, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
    for (const [status, count] of counts) {
      queue[status] = count;
    }
    return queue;
  }

  private typeSummary(
    counts: Array<{
      _id: { jobType: SdgbJobType; status: SdgbJobStatus };
      count: number;
    }>,
  ) {
    const rows = SDGB_JOB_TYPES.map((jobType) => ({
      jobType,
      queued: 0,
      processing: 0,
      completedLastHour: 0,
      failedLastHour: 0,
    }));
    const byType = new Map(rows.map((row) => [row.jobType, row]));
    for (const row of counts) {
      const target = byType.get(row._id.jobType);
      if (!target) {
        continue;
      }
      if (row._id.status === 'queued') {
        target.queued = row.count;
      } else if (row._id.status === 'processing') {
        target.processing = row.count;
      } else if (row._id.status === 'completed') {
        target.completedLastHour = row.count;
      } else {
        target.failedLastHour = row.count;
      }
    }
    return rows;
  }
}
