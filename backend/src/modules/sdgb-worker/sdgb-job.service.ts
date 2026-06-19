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
}
