import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import type { Model } from 'mongoose';

import {
  SdgbJobEntity,
  type SdgbJobDocument,
  type SdgbJobStatus,
  type SdgbJobType,
} from './sdgb-job.schema';
import {
  SdgbWorkerStatusEntity,
  type SdgbWorkerStatusDocument,
} from './sdgb-worker-status.schema';

/** A claim can be reclaimed if the worker hasn't patched it within this window. */
const CLAIM_TIMEOUT_MS = Number(process.env.SDGB_CLAIM_TIMEOUT_MS ?? 2 * 60 * 1000);

/** Queued jobs older than this are auto-failed (the worker is presumed down). */
const QUEUE_TIMEOUT_MS = Number(process.env.SDGB_QUEUE_TIMEOUT_MS ?? 10 * 60 * 1000);

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

/**
 * Drop large array/object fields from sdgb job `result` for admin-list
 * views. Frontend only reads scalar summary keys (`cabinetUserId`, `hash`,
 * `returnCode1/2`); `music: MusicEntry[]` can be 40KB per row and was
 * the dominant cost of GET /admin/sdgb-worker/status (785KB / 339s).
 */
function stripBigFields(
  result: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!result) return result;
  const slim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) {
      slim[`${k}_count`] = v.length;
      continue;
    }
    if (v && typeof v === 'object') continue; // drop nested blobs
    slim[k] = v;
  }
  return slim;
}

@Injectable()
export class SdgbJobService {
  private readonly logger = new Logger(SdgbJobService.name);

  constructor(
    @InjectModel(SdgbJobEntity.name)
    private readonly model: Model<SdgbJobDocument>,
    @InjectModel(SdgbWorkerStatusEntity.name)
    private readonly statusModel: Model<SdgbWorkerStatusDocument>,
  ) {}

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
    return toView(doc.toObject() as SdgbJobEntity);
  }

  async get(jobId: string): Promise<SdgbJobView> {
    const doc = await this.model.findOne({ id: jobId });
    if (!doc) throw new NotFoundException('Sdgb job not found');
    return toView(doc.toObject() as SdgbJobEntity);
  }

  /**
   * Single-worker FIFO claim. We don't bother with multiple workers — the
   * cabinet must not be hit concurrently, so only one sdgb-worker should
   * exist. workerId is logged for traceability.
   */
  async claimNext(workerId: string): Promise<SdgbJobView | null> {
    const now = new Date();

    // Heartbeat first — every poll counts as "worker is alive", regardless
    // of whether we end up returning a job.
    await this.statusModel.updateOne(
      { workerId },
      { $set: { lastSeenAt: now } },
      { upsert: true },
    );

    // Release stale claims first.
    const staleThreshold = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
    await this.model.updateMany(
      {
        status: 'processing',
        executing: true,
        claimedAt: { $lte: staleThreshold },
      },
      {
        $set: {
          status: 'queued',
          executing: false,
          claimedAt: null,
          updatedAt: now,
        },
      },
    );

    // Auto-fail jobs that have been queued forever.
    const queueDeadline = new Date(now.getTime() - QUEUE_TIMEOUT_MS);
    await this.model.updateMany(
      { status: 'queued', createdAt: { $lte: queueDeadline } },
      {
        $set: {
          status: 'failed',
          error: 'sdgb-worker did not pick up the job in time',
          updatedAt: now,
        },
      },
    );

    const claimed = await this.model.findOneAndUpdate(
      { status: 'queued', executing: false },
      {
        $set: {
          status: 'processing',
          executing: true,
          claimedAt: now,
          updatedAt: now,
        },
      },
      { new: true, sort: { createdAt: 1 } },
    );

    if (!claimed) return null;
    await this.statusModel.updateOne(
      { workerId },
      { $inc: { jobsClaimed: 1 } },
    );
    this.logger.log(
      `worker=${workerId} claimed job ${claimed.id} (${claimed.jobType})`,
    );
    return toView(claimed.toObject() as SdgbJobEntity);
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
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status !== undefined) update.status = body.status;
    if (body.result !== undefined) update.result = body.result;
    if (body.error !== undefined) update.error = body.error;
    if (
      body.status === 'completed' ||
      body.status === 'failed'
    ) {
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

  /**
   * Admin dashboard: rolled-up snapshot of the sdgb subsystem health.
   * Returns worker heartbeats, queue depth by status/type, recent jobs,
   * and the current oldest queued/in-flight age.
   */
  async getAdminStatus(): Promise<{
    workers: Array<{
      workerId: string;
      lastSeenAt: string;
      ageSeconds: number;
      jobsClaimed: number;
      alive: boolean;
    }>;
    queue: {
      queued: number;
      processing: number;
      completed: number;
      failed: number;
    };
    byType: Array<{
      jobType: SdgbJobType;
      queued: number;
      processing: number;
      completedLastHour: number;
      failedLastHour: number;
    }>;
    oldestQueuedAgeSeconds: number | null;
    oldestProcessingAgeSeconds: number | null;
    recentJobs: Array<
      SdgbJobView & { ageSeconds: number; durationMs: number | null }
    >;
  }> {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);

    const [workerDocs, statusCounts, oldestQueued, oldestProcessing] =
      await Promise.all([
        this.statusModel.find().lean(),
        this.model.aggregate<{ _id: SdgbJobStatus; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        this.model.findOne({ status: 'queued' }).sort({ createdAt: 1 }).lean(),
        this.model
          .findOne({ status: 'processing' })
          .sort({ claimedAt: 1 })
          .lean(),
      ]);

    const queue = { queued: 0, processing: 0, completed: 0, failed: 0 };
    for (const c of statusCounts) {
      if (c._id in queue) {
        queue[c._id] = c.count;
      }
    }

    const typeBuckets = await this.model.aggregate<{
      _id: { jobType: SdgbJobType; bucket: string };
      count: number;
    }>([
      {
        $facet: {
          live: [
            {
              $match: { status: { $in: ['queued', 'processing'] } },
            },
            {
              $group: {
                _id: { jobType: '$jobType', bucket: '$status' },
                count: { $sum: 1 },
              },
            },
          ],
          recent: [
            { $match: { createdAt: { $gte: oneHourAgo } } },
            {
              $match: { status: { $in: ['completed', 'failed'] } },
            },
            {
              $group: {
                _id: { jobType: '$jobType', bucket: '$status' },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
      { $project: { merged: { $concatArrays: ['$live', '$recent'] } } },
      { $unwind: '$merged' },
      { $replaceRoot: { newRoot: '$merged' } },
    ]);

    const byTypeMap = new Map<
      SdgbJobType,
      {
        queued: number;
        processing: number;
        completedLastHour: number;
        failedLastHour: number;
      }
    >();
    const ensure = (t: SdgbJobType) => {
      if (!byTypeMap.has(t)) {
        byTypeMap.set(t, {
          queued: 0,
          processing: 0,
          completedLastHour: 0,
          failedLastHour: 0,
        });
      }
      return byTypeMap.get(t)!;
    };
    for (const t of ['scan_qr', 'get_rival_hash', 'add_rival'] as const) {
      ensure(t);
    }
    for (const row of typeBuckets) {
      const slot = ensure(row._id.jobType);
      const bucket = row._id.bucket;
      if (bucket === 'queued') slot.queued = row.count;
      else if (bucket === 'processing') slot.processing = row.count;
      else if (bucket === 'completed') slot.completedLastHour = row.count;
      else if (bucket === 'failed') slot.failedLastHour = row.count;
    }

    const recentDocs = await this.model
      .find()
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();
    const recentJobs = recentDocs.map((doc) => {
      const view = toView(doc as SdgbJobEntity);
      const created = new Date(view.createdAt).getTime();
      const updated = new Date(view.updatedAt).getTime();
      const isTerminal =
        view.status === 'completed' || view.status === 'failed';
      // 减肥：admin 列表只在 result 里读 cabinetUserId / hash / returnCode1 /
      // returnCode2 这些标量；result.music (MusicEntry[]) 单条几十 KB，
      // 20 条就 ~785KB，是这个接口慢的主要原因。
      const slimResult = stripBigFields(view.result);
      return {
        ...view,
        result: slimResult,
        ageSeconds: Math.round((now - created) / 1000),
        durationMs: isTerminal ? updated - created : null,
      };
    });

    const ALIVE_WINDOW_MS = Number(
      process.env.SDGB_WORKER_ALIVE_WINDOW_MS ?? 30_000,
    );
    const workers = workerDocs.map((w) => {
      const lastSeen = new Date(w.lastSeenAt).getTime();
      const ageSeconds = Math.round((now - lastSeen) / 1000);
      return {
        workerId: w.workerId,
        lastSeenAt: new Date(w.lastSeenAt).toISOString(),
        ageSeconds,
        jobsClaimed: w.jobsClaimed ?? 0,
        alive: now - lastSeen <= ALIVE_WINDOW_MS,
      };
    });

    return {
      workers,
      queue,
      byType: Array.from(byTypeMap.entries()).map(([jobType, v]) => ({
        jobType,
        ...v,
      })),
      oldestQueuedAgeSeconds: oldestQueued
        ? Math.round((now - new Date(oldestQueued.createdAt).getTime()) / 1000)
        : null,
      oldestProcessingAgeSeconds:
        oldestProcessing && oldestProcessing.claimedAt
          ? Math.round(
              (now - new Date(oldestProcessing.claimedAt).getTime()) / 1000,
            )
          : null,
      recentJobs,
    };
  }

  /**
   * Paginated, filterable list of sdgb jobs for the admin portal. Filters
   * are all optional and combined with AND. Sorted by createdAt desc so
   * the newest job is on page 1.
   */
  async listJobs(opts: {
    jobType?: SdgbJobType;
    status?: SdgbJobStatus;
    /** Substring match against requesterTag (case-insensitive). */
    tag?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    items: Array<SdgbJobView & { ageSeconds: number; durationMs: number | null }>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 20)));
    const filter: Record<string, unknown> = {};
    if (opts.jobType) filter.jobType = opts.jobType;
    if (opts.status) filter.status = opts.status;
    if (opts.tag && opts.tag.trim()) {
      // Escape regex meta-chars; simple safe approach
      const safe = opts.tag.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.requesterTag = { $regex: safe, $options: 'i' };
    }
    const [docs, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      this.model.countDocuments(filter),
    ]);
    const now = Date.now();
    const items = docs.map((doc) => {
      const view = toView(doc as SdgbJobEntity);
      const created = new Date(view.createdAt).getTime();
      const updated = new Date(view.updatedAt).getTime();
      const isTerminal =
        view.status === 'completed' || view.status === 'failed';
      return {
        ...view,
        result: stripBigFields(view.result),
        ageSeconds: Math.round((now - created) / 1000),
        durationMs: isTerminal ? updated - created : null,
      };
    });
    return { items, total, page, pageSize };
  }
}
