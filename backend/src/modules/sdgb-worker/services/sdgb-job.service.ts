import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import type { Model } from 'mongoose';
import { Queue, QueueEvents } from 'bullmq';
import type { SdgbWorkerJobData } from '@maimai-score-hub/shared';

import {
  SdgbJobEntity,
  type SdgbJobDocument,
  type SdgbJobStage,
  type SdgbJobStatus,
  type SdgbJobType,
  type SdgbSessionCleanupStatus,
} from '../schemas/sdgb-job.schema';
import { RedisService } from '../../../common/redis/redis.service';
import {
  DEFAULT_WORKER_JOB_OPTIONS,
  SDGB_WORKER_QUEUE_NAME,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';
import { ObservabilityIngestService } from '../../observability/services/observability-ingest.service';

const WORKER_STALE_MS = Number(
  process.env.SDGB_WORKER_STALE_MS ?? 2 * 60 * 1000,
);
const RECENT_JOB_LIMIT = 20;
const SDGB_JOB_TYPES: SdgbJobType[] = [
  'scan_qr',
  'get_rival_hash',
  'get_user_map',
  'add_rival',
  'get_music_score',
];
const TERMINAL_STATUSES: SdgbJobStatus[] = ['completed', 'failed'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SdgbJobView {
  id: string;
  jobType: SdgbJobType;
  status: SdgbJobStatus;
  stage: SdgbJobStage | null;
  cleanupStatus: SdgbSessionCleanupStatus;
  cleanupErrorCode: string | null;
  cleanupUpdatedAt: string | null;
  cleanupBlockedUntil: string | null;
  progress: { detailsFetched: number } | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  errorCode: string | null;
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

function toView(doc: SdgbJobEntity, redactSensitive = false): SdgbJobView {
  const payload = { ...(doc.payload ?? {}) };
  if (redactSensitive && doc.jobType === 'get_music_score') {
    if ('qrCode' in payload) {
      payload.qrCode = '[REDACTED]';
    }
    if ('expectedCabinetUserId' in payload) {
      payload.expectedCabinetUserId = '[REDACTED]';
    }
  }
  return {
    id: doc.id,
    jobType: doc.jobType,
    status: doc.status,
    stage: doc.stage ?? null,
    cleanupStatus: doc.cleanupStatus ?? 'not_required',
    cleanupErrorCode: doc.cleanupErrorCode ?? null,
    cleanupUpdatedAt: doc.cleanupUpdatedAt?.toISOString() ?? null,
    cleanupBlockedUntil: doc.cleanupBlockedUntil?.toISOString() ?? null,
    progress: doc.progress ?? null,
    payload,
    result: doc.result,
    error: doc.error,
    errorCode: doc.errorCode ?? null,
    requesterTag: doc.requesterTag ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function secondsSince(
  date: Date | null | undefined,
  nowMs: number,
): number | null {
  if (!date) {
    return null;
  }
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
    ...toView(doc, true),
    ageSeconds: secondsSince(doc.updatedAt, nowMs) ?? 0,
    durationMs,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSdgbTimelineEventName(status: SdgbJobStatus): string {
  if (status === 'processing') {
    return 'picked';
  }
  if (status === 'completed' || status === 'failed') {
    return status;
  }
  return 'status_changed';
}

@Injectable()
export class SdgbJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SdgbJobService.name);
  private readonly sdgbQueue: Queue<SdgbWorkerJobData>;
  private readonly sdgbQueueEvents: QueueEvents;
  private readonly workerStatusTtlSeconds: number;

  constructor(
    @InjectModel(SdgbJobEntity.name)
    private readonly model: Model<SdgbJobDocument>,
    private readonly redis: RedisService,
    private readonly observability: ObservabilityIngestService,
    config: ConfigService,
  ) {
    const queueOptions = createBullmqQueueOptions(config);
    this.sdgbQueue = new Queue<SdgbWorkerJobData>(SDGB_WORKER_QUEUE_NAME, {
      ...queueOptions,
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
    this.sdgbQueueEvents = new QueueEvents(
      SDGB_WORKER_QUEUE_NAME,
      queueOptions,
    );
    this.workerStatusTtlSeconds = Math.max(
      1,
      Math.floor(WORKER_STALE_MS / 1000) * 2,
    );
  }

  onModuleInit(): void {
    this.ensureSdgbQueueEvents();
  }

  async onModuleDestroy(): Promise<void> {
    await this.sdgbQueue.close();
    await this.sdgbQueueEvents.close();
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
    ownerUserId?: string | null;
    ownerFriendCode?: string | null;
  }): Promise<SdgbJobView> {
    const id = randomUUID();
    const now = new Date();
    const doc = await this.model.create({
      id,
      jobType: input.jobType,
      status: 'queued',
      stage: input.jobType === 'get_music_score' ? 'queued' : null,
      cleanupStatus: 'not_required',
      cleanupErrorCode: null,
      cleanupUpdatedAt: null,
      cleanupBlockedUntil: null,
      progress: null,
      payload: input.payload,
      result: null,
      error: null,
      errorCode: null,
      executing: false,
      claimedAt: null,
      requesterTag: input.requesterTag ?? null,
      ownerUserId: input.ownerUserId ?? null,
      ownerFriendCode: input.ownerFriendCode ?? null,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.addBullmqJob(id, input.jobType);
    } catch (err) {
      const message = `failed to enqueue sdgb BullMQ job: ${errorMessage(err)}`;
      await this.model.updateOne(
        { id, status: 'queued' },
        {
          $set: {
            status: 'failed',
            error: message,
            errorCode: 'QUEUE_ENQUEUE_FAILED',
            updatedAt: new Date(),
          },
          ...(input.jobType === 'get_music_score'
            ? { $unset: { 'payload.qrCode': 1 } }
            : {}),
        },
      );
      throw err;
    }
    this.observability.recordJobTimelineEvent({
      ts: now,
      jobId: id,
      jobKind: 'sdgb',
      jobType: input.jobType,
      eventName: 'queued',
      toStatus: 'queued',
      attrs: {
        requesterTag: input.requesterTag ?? '',
      },
    });
    return toView(doc.toObject() as SdgbJobEntity);
  }

  async getEntity(jobId: string): Promise<SdgbJobEntity> {
    const doc = await this.model.findOne({ id: jobId }).lean<SdgbJobEntity>();
    if (!doc) {
      throw new NotFoundException('Sdgb job not found');
    }
    return doc;
  }

  async getOwned(jobId: string, ownerUserId: string): Promise<SdgbJobView> {
    const doc = await this.model
      .findOne({ id: jobId, ownerUserId })
      .lean<SdgbJobEntity>();
    if (!doc) {
      throw new NotFoundException('Sdgb job not found');
    }
    return toView(doc);
  }

  async getActiveOwned(ownerUserId: string): Promise<SdgbJobView | null> {
    const now = new Date();
    const doc = await this.model
      .findOne({
        ownerUserId,
        jobType: 'get_music_score',
        $or: [
          { status: { $in: ['queued', 'processing'] } },
          { cleanupStatus: 'pending' },
          {
            cleanupStatus: 'unconfirmed',
            cleanupBlockedUntil: { $gt: now },
          },
        ],
      })
      .sort({ createdAt: -1 })
      .lean<SdgbJobEntity>();
    return doc ? toView(doc) : null;
  }

  async get(jobId: string): Promise<SdgbJobView> {
    const doc = await this.model.findOne({ id: jobId });
    if (!doc) {
      throw new NotFoundException('Sdgb job not found');
    }
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
      if (!target) {
        continue;
      }
      if (row._id.status === 'queued') {
        target.queued = row.count;
      }
      if (row._id.status === 'processing') {
        target.processing = row.count;
      }
      if (row._id.status === 'completed') {
        target.completedLastHour = row.count;
      }
      if (row._id.status === 'failed') {
        target.failedLastHour = row.count;
      }
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
  // The patch surface intentionally mirrors the worker's compact state machine.
  // eslint-disable-next-line complexity
  async patch(
    jobId: string,
    body: {
      status?: SdgbJobStatus;
      stage?: SdgbJobStage;
      cleanupStatus?: SdgbSessionCleanupStatus;
      cleanupErrorCode?: string | null;
      cleanupBlockedUntil?: string | null;
      progress?: { detailsFetched: number } | null;
      result?: Record<string, unknown> | null;
      error?: string | null;
      errorCode?: string | null;
    },
  ): Promise<SdgbJobView> {
    const now = new Date();
    const existing = await this.model
      .findOne({ id: jobId })
      .lean<SdgbJobEntity>();
    if (!existing) {
      throw new NotFoundException('Sdgb job not found');
    }
    const update: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) {
      update.status = body.status;
    }
    if (body.stage !== undefined) {
      update.stage = body.stage;
    }
    if (body.cleanupStatus !== undefined) {
      if (
        existing.cleanupStatus === 'succeeded' &&
        body.cleanupStatus !== 'succeeded'
      ) {
        throw new BadRequestException('cleanupStatus cannot leave succeeded');
      }
      update.cleanupStatus = body.cleanupStatus;
      update.cleanupUpdatedAt = now;
    }
    if (body.cleanupErrorCode !== undefined) {
      update.cleanupErrorCode = body.cleanupErrorCode;
    }
    if (body.cleanupBlockedUntil !== undefined) {
      update.cleanupBlockedUntil = body.cleanupBlockedUntil
        ? new Date(body.cleanupBlockedUntil)
        : null;
    }
    if (body.progress !== undefined) {
      update.progress = body.progress;
    }
    if (body.result !== undefined) {
      update.result = body.result;
    }
    if (body.error !== undefined) {
      update.error = body.error;
    }
    if (body.errorCode !== undefined) {
      update.errorCode = body.errorCode;
    }
    if (body.status === 'processing') {
      update.executing = true;
      update.claimedAt = now;
    }
    if (body.status === 'completed' || body.status === 'failed') {
      update.executing = false;
    }

    const shouldScrubQr =
      existing.jobType === 'get_music_score' && body.status === 'failed';
    const mongoUpdate: Record<string, unknown> = { $set: update };
    if (shouldScrubQr) {
      mongoUpdate.$unset = { 'payload.qrCode': 1 };
    }
    const doc = await this.model.findOneAndUpdate({ id: jobId }, mongoUpdate, {
      new: true,
    });
    if (!doc) {
      throw new NotFoundException('Sdgb job not found');
    }
    const updated = doc.toObject() as SdgbJobEntity;
    if (body.status !== undefined && existing.status !== updated.status) {
      this.observability.recordJobTimelineEvent({
        ts: now,
        jobId,
        jobKind: 'sdgb',
        jobType: updated.jobType,
        eventName: getSdgbTimelineEventName(updated.status),
        fromStatus: existing.status,
        toStatus: updated.status,
        durationMs:
          updated.status === 'completed' || updated.status === 'failed'
            ? now.getTime() - updated.createdAt.getTime()
            : null,
        errorClass: updated.status === 'failed' ? 'sdgb_job_failed' : null,
        message: updated.error,
      });
    }
    return toView(updated);
  }

  async completeMusicScoreFinalization(
    jobId: string,
    result: { syncId: string; scoreCount: number },
  ): Promise<SdgbJobView> {
    const now = new Date();
    const doc = await this.model.findOneAndUpdate(
      {
        id: jobId,
        jobType: 'get_music_score',
        cleanupStatus: 'succeeded',
        status: { $nin: TERMINAL_STATUSES },
      },
      {
        $set: {
          status: 'completed',
          stage: 'persist',
          executing: false,
          result,
          error: null,
          errorCode: null,
          updatedAt: now,
        },
        $unset: { 'payload.qrCode': 1 },
      },
      { new: true },
    );
    if (!doc) {
      const existing = await this.model.findOne({ id: jobId });
      if (existing?.status === 'completed') {
        return toView(existing.toObject() as SdgbJobEntity);
      }
      throw new BadRequestException(
        'music score job cannot complete before cleanup succeeds',
      );
    }
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
      if (job.status === 'completed') {
        return job;
      }
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

  private async addBullmqJob(
    jobId: string,
    jobType: SdgbJobType,
  ): Promise<void> {
    await this.sdgbQueue.add(
      'sdgb-job',
      { jobId },
      {
        jobId,
        priority: jobType === 'get_music_score' ? 1 : 10,
      },
    );
  }

  private ensureSdgbQueueEvents(): void {
    this.sdgbQueueEvents.on('failed', ({ jobId, failedReason }) => {
      if (!jobId) {
        return;
      }
      this.markBullmqJobFailed(jobId, failedReason).catch((err) => {
        this.logger.warn(
          `failed to mirror sdgb BullMQ failure for ${jobId}: ${errorMessage(
            err,
          )}`,
        );
      });
    });
    this.sdgbQueueEvents.on('stalled', ({ jobId }) => {
      this.logger.warn(`SDGB BullMQ job stalled job=${jobId}`);
    });
    this.sdgbQueueEvents.on('error', (err) => {
      this.logger.warn(`SDGB BullMQ queue events error: ${err.message}`);
    });
  }

  private async markBullmqJobFailed(
    jobId: string,
    failedReason?: string,
  ): Promise<void> {
    await this.model.updateOne(
      { id: jobId, status: { $nin: TERMINAL_STATUSES } },
      {
        $set: {
          status: 'failed',
          executing: false,
          error: failedReason || 'BullMQ job failed',
          errorCode: 'BULLMQ_JOB_FAILED',
          updatedAt: new Date(),
        },
        $unset: { 'payload.qrCode': 1 },
      },
    );
  }

  async repairMissingQueuedJobs(
    minAgeMs: number,
    batchSize: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const cutoff = new Date(Date.now() - minAgeMs);
    const jobs = await this.model
      .find({ status: 'queued', createdAt: { $lte: cutoff } })
      .sort({ createdAt: 1 })
      .limit(batchSize)
      .lean<SdgbJobEntity[]>();

    let repaired = 0;
    for (const job of jobs) {
      signal?.throwIfAborted();
      const existing = await this.sdgbQueue.getJob(job.id);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'failed' && state !== 'completed') {
          continue;
        }
        await existing.remove();
      }

      try {
        await this.addBullmqJob(job.id, job.jobType);
        repaired += 1;
      } catch (err) {
        this.logger.warn(
          `failed to repair missing sdgb BullMQ job ${job.id}: ${errorMessage(
            err,
          )}`,
        );
      }
    }

    if (repaired > 0) {
      this.logger.warn(`repaired ${repaired} missing sdgb BullMQ jobs`);
    }
  }
}
