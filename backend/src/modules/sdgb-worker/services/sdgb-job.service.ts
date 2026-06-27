import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import type { Model } from 'mongoose';
import { Queue } from 'bullmq';
import type { SdgbWorkerJobData } from '@maimai-score-hub/shared';

import {
  SdgbJobEntity,
  type SdgbJobDocument,
  type SdgbJobStatus,
  type SdgbJobType,
} from '../schemas/sdgb-job.schema';
import { RedisService } from '../../../common/redis/redis.service';
import {
  DEFAULT_WORKER_JOB_OPTIONS,
  SDGB_WORKER_QUEUE_NAME,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';

const WORKER_STALE_MS = Number(
  process.env.SDGB_WORKER_STALE_MS ?? 2 * 60 * 1000,
);
const RECENT_JOB_LIMIT = 20;
const SDGB_JOB_TYPES: SdgbJobType[] = [
  'scan_qr',
  'get_rival_hash',
  'get_user_map',
  'add_rival',
];

export interface SdgbJobView {
  id: string;
  jobType: SdgbJobType;
  status: SdgbJobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  requesterTag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SdgbAdminJobView extends SdgbJobView {
  ageSeconds: number;
  durationMs: number | null;
}

export interface SdgbAdminStatusView {
  workers: Array<{
    workerId: string;
    lastSeenAt: string;
    ageSeconds: number;
    jobsClaimed: number;
    alive: boolean;
  }>;
  queue: Record<SdgbJobStatus, number>;
  byType: Array<{
    jobType: SdgbJobType;
    queued: number;
    processing: number;
    completedLastHour: number;
    failedLastHour: number;
  }>;
  oldestQueuedAgeSeconds: number | null;
  oldestProcessingAgeSeconds: number | null;
  recentJobs: SdgbAdminJobView[];
}

export interface SdgbJobListOptions {
  jobType?: SdgbJobType;
  status?: SdgbJobStatus;
  tag?: string;
  page: number;
  pageSize: number;
}

export interface SdgbJobListView {
  items: SdgbAdminJobView[];
  total: number;
  page: number;
  pageSize: number;
}

interface SdgbWorkerStatus {
  workerId: string;
  lastSeenAt: string;
  jobsClaimed: number;
}

function toView(doc: SdgbJobEntity): SdgbJobView {
  return {
    id: doc.id,
    jobType: doc.jobType,
    status: doc.status,
    payload: doc.payload,
    result: doc.result,
    error: doc.error,
    requesterTag: doc.requesterTag ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function secondsSince(
  date: Date | null | undefined,
  nowMs: number,
): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
}

function toAdminView(doc: SdgbJobEntity, nowMs: number): SdgbAdminJobView {
  let durationMs: number | null = null;
  if (doc.status === 'processing') {
    const startedAt = doc.claimedAt ?? doc.updatedAt;
    durationMs = Math.max(0, nowMs - startedAt.getTime());
  } else if (doc.status === 'completed' || doc.status === 'failed') {
    durationMs = Math.max(0, doc.updatedAt.getTime() - doc.createdAt.getTime());
  }
  return {
    ...toView(doc),
    ageSeconds: secondsSince(doc.updatedAt, nowMs) ?? 0,
    durationMs,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class SdgbJobService implements OnModuleDestroy {
  private readonly logger = new Logger(SdgbJobService.name);
  private readonly sdgbQueue: Queue<SdgbWorkerJobData>;
  private readonly workerStatusTtlSeconds: number;

  constructor(
    @InjectModel(SdgbJobEntity.name)
    private readonly model: Model<SdgbJobDocument>,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.sdgbQueue = new Queue<SdgbWorkerJobData>(SDGB_WORKER_QUEUE_NAME, {
      ...createBullmqQueueOptions(config),
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
    this.workerStatusTtlSeconds = Math.max(
      1,
      Math.floor(WORKER_STALE_MS / 1000) * 2,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.sdgbQueue.close();
  }

  /**
   * Insert a new job in `queued` state and return its view. Producers (e.g.
   * CabinetService.bindByQr, AutoUpdateScheduler) call this and then poll
   * `waitForCompletion` for the result.
   */
  async enqueue(input: {
    jobType: SdgbJobType;
    payload: Record<string, unknown>;
    requesterTag?: string | null;
  }): Promise<SdgbJobView> {
    const id = randomUUID();
    const now = new Date();
    const doc = await this.model.create({
      id,
      jobType: input.jobType,
      status: 'queued',
      payload: input.payload,
      result: null,
      error: null,
      executing: false,
      claimedAt: null,
      requesterTag: input.requesterTag ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await this.sdgbQueue.add(
      'sdgb-job',
      { jobId: id },
      {
        jobId: id,
      },
    );
    return toView(doc.toObject() as SdgbJobEntity);
  }

  async get(jobId: string): Promise<SdgbJobView> {
    const doc = await this.model.findOne({ id: jobId });
    if (!doc) throw new NotFoundException('Sdgb job not found');
    return toView(doc.toObject() as SdgbJobEntity);
  }

  async getAdminStatus(): Promise<SdgbAdminStatusView> {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const oneHourAgo = new Date(nowMs - 60 * 60 * 1000);

    const [
      workers,
      queueCounts,
      byTypeCounts,
      oldestQueued,
      oldestProcessing,
      recentJobs,
    ] = await Promise.all([
      this.getWorkerStatuses(),
      Promise.all(
        (
          ['queued', 'processing', 'completed', 'failed'] as SdgbJobStatus[]
        ).map(
          async (status) =>
            [status, await this.model.countDocuments({ status })] as const,
        ),
      ),
      this.model
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
        .exec(),
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

    const queue: Record<SdgbJobStatus, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
    for (const [status, count] of queueCounts) {
      queue[status] = count;
    }

    const byType = SDGB_JOB_TYPES.map((jobType) => ({
      jobType,
      queued: 0,
      processing: 0,
      completedLastHour: 0,
      failedLastHour: 0,
    }));
    const byTypeMap = new Map(byType.map((row) => [row.jobType, row]));
    for (const row of byTypeCounts) {
      const target = byTypeMap.get(row._id.jobType);
      if (!target) continue;
      if (row._id.status === 'queued') target.queued = row.count;
      if (row._id.status === 'processing') target.processing = row.count;
      if (row._id.status === 'completed') target.completedLastHour = row.count;
      if (row._id.status === 'failed') target.failedLastHour = row.count;
    }

    return {
      workers: workers.map((worker) => {
        const lastSeenAt = new Date(worker.lastSeenAt);
        const ageSeconds = secondsSince(lastSeenAt, nowMs) ?? 0;
        return {
          workerId: worker.workerId,
          lastSeenAt: lastSeenAt.toISOString(),
          ageSeconds,
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
      recentJobs: recentJobs.map((job) => toAdminView(job, nowMs)),
    };
  }

  async listJobs(opts: SdgbJobListOptions): Promise<SdgbJobListView> {
    const page = Math.max(1, opts.page);
    const pageSize = Math.min(200, Math.max(1, opts.pageSize));
    const filter: Record<string, unknown> = {};
    if (opts.jobType) filter.jobType = opts.jobType;
    if (opts.status) filter.status = opts.status;
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
      items: docs.map((job) => toAdminView(job, nowMs)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Worker-driven update. Setting `status` to a terminal value (completed
   * or failed) clears the executing flag. Anything else just patches result/
   * error/heartbeat-style updatedAt.
   */
  async patch(
    jobId: string,
    body: {
      status?: SdgbJobStatus;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<SdgbJobView> {
    const now = new Date();
    const update: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) update.status = body.status;
    if (body.result !== undefined) update.result = body.result;
    if (body.error !== undefined) update.error = body.error;
    if (body.status === 'processing') {
      update.executing = true;
      update.claimedAt = now;
    }
    if (body.status === 'completed' || body.status === 'failed') {
      update.executing = false;
    }

    const doc = await this.model.findOneAndUpdate(
      { id: jobId },
      { $set: update },
      { new: true },
    );
    if (!doc) throw new NotFoundException('Sdgb job not found');
    return toView(doc.toObject() as SdgbJobEntity);
  }

  async reportWorkerStatus(
    workerId: string,
    claimedDelta = 0,
    seenAt: Date = new Date(),
  ): Promise<void> {
    await this.touchWorkerStatus(workerId, seenAt, claimedDelta);
  }

  /**
   * Producer-side helper: poll until the job hits a terminal state, throw
   * on `failed` / timeout. Used by CabinetService.bindByQr (synchronous
   * caller) and AutoUpdateScheduler (which can wait too — these are short
   * jobs running on a single-concurrency worker).
   */
  async waitForCompletion(
    jobId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<SdgbJobView> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.get(jobId);
      if (job.status === 'completed') return job;
      if (job.status === 'failed') {
        throw new Error(job.error ?? `sdgb job ${jobId} failed`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`sdgb job ${jobId} timed out after ${timeoutMs}ms`);
  }

  private async getWorkerStatuses(): Promise<SdgbWorkerStatus[]> {
    const keys = await this.redis.keys(this.redis.key('status:worker:sdgb:*'));
    const rows: SdgbWorkerStatus[] = [];
    for (const key of keys) {
      const status = await this.redis.getJson<SdgbWorkerStatus>(key);
      if (status?.workerId && status.lastSeenAt) {
        rows.push({
          workerId: status.workerId,
          lastSeenAt: status.lastSeenAt,
          jobsClaimed: status.jobsClaimed ?? 0,
        });
      }
    }
    return rows.sort(
      (a, b) =>
        new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
    );
  }

  private async touchWorkerStatus(
    workerId: string,
    seenAt: Date,
    claimedDelta: number,
  ): Promise<void> {
    const key = this.workerStatusKey(workerId);
    const previous = await this.redis.getJson<SdgbWorkerStatus>(key);
    await this.redis.setJson(
      key,
      {
        workerId,
        lastSeenAt: seenAt.toISOString(),
        jobsClaimed: (previous?.jobsClaimed ?? 0) + claimedDelta,
      },
      { ttlSeconds: this.workerStatusTtlSeconds },
    );
  }

  private workerStatusKey(workerId: string): string {
    return this.redis.key(`status:worker:sdgb:${workerId}`);
  }
}
