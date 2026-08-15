import {
  BadRequestException,
  ConflictException,
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
import {
  SDGB_QUEUE_NAME_BY_LANE,
  DXNET_PRIORITY,
  getSdgbWorkerLaneForJobType,
  toDxnetBullmqPriority,
  type SdgbJobPatchBody,
  type SdgbWorkerJobData,
  type SdgbWorkerLane,
} from '@maimai-score-hub/shared';

import {
  SdgbJobEntity,
  type SdgbJobDocument,
  type SdgbJobStatus,
  type SdgbJobType,
} from '../schemas/sdgb-job.schema';
import {
  DEFAULT_WORKER_JOB_OPTIONS,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';
import { ObservabilityIngestService } from '../../observability/services/observability-ingest.service';
import { SdgbWorkerRegistryService } from './sdgb-worker-registry.service';
import {
  sdgbTimelineEventName,
  toSdgbJobView as toView,
  type SdgbAdminStatusView,
  type SdgbJobListOptions,
  type SdgbJobListView,
  type SdgbJobView,
} from './sdgb-job.view';
import { SdgbJobAdminQueryService } from './sdgb-job-admin-query.service';
import {
  buildSdgbMongoPatch,
  requireExecution,
  type WorkerExecutionGuard,
} from './sdgb-job-patch';

export type {
  SdgbAdminJobView,
  SdgbAdminStatusView,
  SdgbJobListOptions,
  SdgbJobListView,
  SdgbJobView,
} from './sdgb-job.view';

const SDGB_WORKER_LANES: readonly SdgbWorkerLane[] = ['probe', 'interactive'];
const TERMINAL_STATUSES: SdgbJobStatus[] = ['completed', 'failed'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class SdgbJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SdgbJobService.name);
  private readonly sdgbQueues: Record<SdgbWorkerLane, Queue<SdgbWorkerJobData>>;
  private readonly sdgbQueueEvents: Record<SdgbWorkerLane, QueueEvents>;

  constructor(
    @InjectModel(SdgbJobEntity.name)
    private readonly model: Model<SdgbJobDocument>,
    private readonly observability: ObservabilityIngestService,
    private readonly registry: SdgbWorkerRegistryService,
    private readonly adminQueries: SdgbJobAdminQueryService,
    config: ConfigService,
  ) {
    const queueOptions = createBullmqQueueOptions(config);
    this.sdgbQueues = {
      probe: new Queue<SdgbWorkerJobData>(SDGB_QUEUE_NAME_BY_LANE.probe, {
        ...queueOptions,
        defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
      }),
      interactive: new Queue<SdgbWorkerJobData>(
        SDGB_QUEUE_NAME_BY_LANE.interactive,
        {
          ...queueOptions,
          defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
        },
      ),
    };
    this.sdgbQueueEvents = {
      probe: new QueueEvents(SDGB_QUEUE_NAME_BY_LANE.probe, queueOptions),
      interactive: new QueueEvents(
        SDGB_QUEUE_NAME_BY_LANE.interactive,
        queueOptions,
      ),
    };
  }

  onModuleInit(): void {
    this.ensureSdgbQueueEvents();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      ...Object.values(this.sdgbQueues).map((queue) => queue.close()),
      ...Object.values(this.sdgbQueueEvents).map((events) => events.close()),
    ]);
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
    priority?: number;
    idempotencyKey?: string | null;
  }): Promise<SdgbJobView> {
    const id = randomUUID();
    const now = new Date();
    const lane = getSdgbWorkerLaneForJobType(input.jobType);
    const priority =
      input.priority ??
      (input.jobType === 'scan_qr' || input.jobType === 'get_music_score'
        ? DXNET_PRIORITY.immediate
        : input.jobType === 'add_rival'
          ? DXNET_PRIORITY.background
          : DXNET_PRIORITY.maintenance);
    const values = {
      id,
      jobType: input.jobType,
      lane,
      routingVersion: 1,
      priority,
      idempotencyKey: input.idempotencyKey ?? null,
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
      executionToken: null,
      executionWorkerId: null,
      executionMembershipEpoch: null,
      executionNetworkEpoch: null,
      attempt: 0,
      maxAttempts: 3,
      retryAt: null,
      retryReason: null,
      failureClass: null,
      lastWorkerId: null,
      outcomeUnknown: false,
      requesterTag: input.requesterTag ?? null,
      ownerUserId: input.ownerUserId ?? null,
      ownerFriendCode: input.ownerFriendCode ?? null,
    };
    let doc = await this.createOrReuseJob(values, input.idempotencyKey ?? null);
    if (doc.id !== id) {
      doc = await this.recoverQueueEnqueueFailure(doc);
      return toView(doc.toObject() as SdgbJobEntity);
    }
    await this.enqueueBullmqDelivery(doc);
    this.observability.recordJobTimelineEvent({
      ts: now,
      jobId: id,
      jobKind: 'sdgb',
      jobType: input.jobType,
      eventName: 'queued',
      toStatus: 'queued',
      attrs: {
        requesterTag: input.requesterTag ?? '',
        priority,
      },
    });
    return toView(doc.toObject() as SdgbJobEntity);
  }

  private async createOrReuseJob(
    values: Record<string, unknown>,
    idempotencyKey: string | null,
  ): Promise<SdgbJobDocument> {
    if (!idempotencyKey) {
      return this.model.create(values);
    }
    try {
      return await this.model.findOneAndUpdate(
        { idempotencyKey },
        { $setOnInsert: values },
        { upsert: true, new: true },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
      const existing = await this.model.findOne({ idempotencyKey });
      if (!existing) {
        throw error;
      }
      return existing;
    }
  }

  private async recoverQueueEnqueueFailure(
    doc: SdgbJobDocument,
  ): Promise<SdgbJobDocument> {
    if (
      doc.status !== 'failed' ||
      doc.errorCode !== 'QUEUE_ENQUEUE_FAILED' ||
      doc.outcomeUnknown
    ) {
      return doc;
    }
    const recovered = await this.model.findOneAndUpdate(
      {
        id: doc.id,
        status: 'failed',
        errorCode: 'QUEUE_ENQUEUE_FAILED',
        outcomeUnknown: { $ne: true },
      },
      {
        $set: {
          status: 'queued',
          error: null,
          errorCode: null,
          updatedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!recovered) {
      return (await this.model.findOne({ id: doc.id })) ?? doc;
    }
    await this.enqueueBullmqDelivery(recovered);
    return recovered;
  }

  private async enqueueBullmqDelivery(doc: SdgbJobDocument): Promise<void> {
    try {
      await this.addBullmqJob(
        doc.id,
        doc.jobType,
        doc.attempt ?? 0,
        0,
        doc.priority,
      );
    } catch (error) {
      await this.model.updateOne(
        { id: doc.id, status: 'queued' },
        {
          $set: {
            status: 'failed',
            error: `failed to enqueue sdgb BullMQ job: ${errorMessage(error)}`,
            errorCode: 'QUEUE_ENQUEUE_FAILED',
            updatedAt: new Date(),
          },
          ...(doc.jobType === 'get_music_score'
            ? { $unset: { 'payload.qrCode': 1 } }
            : {}),
        },
      );
      throw error;
    }
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
    return this.adminQueries.getStatus();
  }

  async listJobs(opts: SdgbJobListOptions): Promise<SdgbJobListView> {
    return this.adminQueries.list(opts);
  }

  /**
   * Worker-driven update. Setting `status` to a terminal value (completed
   * or failed) clears the executing flag. Anything else just patches result/
   * error/heartbeat-style updatedAt.
   */
  async patchFromWorker(
    jobId: string,
    body: SdgbJobPatchBody,
  ): Promise<SdgbJobView> {
    const execution = requireExecution(body);
    if (body.requeue) {
      return this.requeueFromWorker(jobId, body, execution);
    }
    return this.patch(jobId, body, execution);
  }

  async assertWorkerExecution(
    jobId: string,
    body: SdgbJobPatchBody,
  ): Promise<void> {
    const execution = requireExecution(body);
    const existing = await this.model
      .findOne({ id: jobId })
      .lean<SdgbJobEntity>();
    if (!existing) {
      throw new NotFoundException('Sdgb job not found');
    }
    await this.workerPatchFilter(jobId, existing, body, execution);
  }

  async patch(
    jobId: string,
    body: SdgbJobPatchBody,
    execution?: WorkerExecutionGuard,
  ): Promise<SdgbJobView> {
    const now = new Date();
    const existing = await this.model
      .findOne({ id: jobId })
      .lean<SdgbJobEntity>();
    if (!existing) {
      throw new NotFoundException('Sdgb job not found');
    }
    const filter = await this.workerPatchFilter(
      jobId,
      existing,
      body,
      execution,
    );
    const mongoUpdate = buildSdgbMongoPatch(existing, body, execution, now);
    const doc = await this.model.findOneAndUpdate(filter, mongoUpdate, {
      new: true,
    });
    if (!doc) {
      throw new ConflictException('sdgb execution fence is no longer active');
    }
    const updated = doc.toObject() as SdgbJobEntity;
    if (body.status !== undefined && existing.status !== updated.status) {
      this.observability.recordJobTimelineEvent({
        ts: now,
        jobId,
        jobKind: 'sdgb',
        jobType: updated.jobType,
        eventName: sdgbTimelineEventName(updated.status),
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

  private async requeueFromWorker(
    jobId: string,
    body: SdgbJobPatchBody,
    execution: WorkerExecutionGuard,
  ): Promise<SdgbJobView> {
    const existing = await this.model
      .findOne({ id: jobId })
      .lean<SdgbJobEntity>();
    if (!existing) {
      throw new NotFoundException('Sdgb job not found');
    }
    if (getSdgbWorkerLaneForJobType(existing.jobType) !== 'probe') {
      throw new BadRequestException(
        'only read-only Probe jobs may be automatically requeued',
      );
    }
    const filter = await this.workerPatchFilter(
      jobId,
      existing,
      body,
      execution,
    );
    const retry = body.requeue;
    if (!retry) {
      throw new BadRequestException('requeue metadata is required');
    }
    const nextAttempt = (existing.attempt ?? 0) + 1;
    const exhausted = nextAttempt >= (existing.maxAttempts ?? 3);
    const now = new Date();
    const retryAt = new Date(retry.retryAt);
    const set: Record<string, unknown> = {
      status: exhausted ? 'failed' : 'queued',
      executing: false,
      attempt: exhausted ? existing.attempt : nextAttempt,
      retryAt: exhausted ? null : retryAt,
      retryReason: retry.retryReason,
      failureClass: retry.failureClass,
      lastWorkerId: execution.executionWorkerId,
      executionToken: null,
      executionWorkerId: null,
      executionMembershipEpoch: null,
      executionNetworkEpoch: null,
      error: retry.retryReason,
      errorCode: exhausted ? 'RETRY_EXHAUSTED' : null,
      updatedAt: now,
    };
    const doc = await this.model.findOneAndUpdate(
      filter,
      { $set: set },
      { new: true },
    );
    if (!doc) {
      throw new ConflictException('sdgb execution fence is no longer active');
    }
    const updated = doc.toObject() as SdgbJobEntity;
    if (!exhausted) {
      await this.addBullmqJob(
        updated.id,
        updated.jobType,
        updated.attempt,
        Math.max(0, retryAt.getTime() - Date.now()),
        updated.priority,
      ).catch((error: unknown) => {
        this.logger.warn(
          'Failed to enqueue sdgb retry job=' +
            updated.id +
            ': ' +
            errorMessage(error),
        );
      });
    }
    return toView(updated);
  }

  private async workerPatchFilter(
    jobId: string,
    existing: SdgbJobEntity,
    body: SdgbJobPatchBody,
    execution?: WorkerExecutionGuard,
  ): Promise<Record<string, unknown>> {
    if (!execution) {
      return { id: jobId };
    }
    const lane = await this.assertExecutionMembership(existing, execution);
    if (body.status === 'processing' && existing.status === 'queued') {
      return {
        id: jobId,
        status: 'queued',
        attempt: existing.attempt ?? 0,
      };
    }
    const sameExecution =
      existing.status === 'processing' &&
      existing.executionToken === execution.executionToken &&
      existing.executionWorkerId === execution.executionWorkerId &&
      existing.executionMembershipEpoch ===
        execution.executionMembershipEpoch &&
      existing.executionNetworkEpoch === execution.executionNetworkEpoch;
    if (
      body.status === 'processing' &&
      existing.status === 'processing' &&
      !sameExecution
    ) {
      const oldMembershipActive =
        existing.executionWorkerId !== null &&
        existing.executionWorkerId !== undefined &&
        existing.executionMembershipEpoch !== null &&
        existing.executionMembershipEpoch !== undefined &&
        (await this.registry.isMembershipActive(
          lane,
          existing.executionWorkerId,
          existing.executionMembershipEpoch,
          existing.executionNetworkEpoch ?? undefined,
        ));
      if (oldMembershipActive) {
        throw new ConflictException(
          'sdgb job is still fenced by an active membership',
        );
      }
      return {
        id: jobId,
        status: 'processing',
        executionToken: existing.executionToken,
        executionWorkerId: existing.executionWorkerId,
        executionMembershipEpoch: existing.executionMembershipEpoch,
        executionNetworkEpoch: existing.executionNetworkEpoch,
      };
    }
    if (existing.status !== 'processing' || !sameExecution) {
      throw new ConflictException('sdgb execution fence is no longer active');
    }
    return {
      id: jobId,
      status: 'processing',
      executionToken: execution.executionToken,
      executionWorkerId: execution.executionWorkerId,
      executionMembershipEpoch: execution.executionMembershipEpoch,
      executionNetworkEpoch: execution.executionNetworkEpoch,
    };
  }

  private async assertExecutionMembership(
    existing: SdgbJobEntity,
    execution: WorkerExecutionGuard,
  ): Promise<SdgbWorkerLane> {
    const lane = existing.lane ?? getSdgbWorkerLaneForJobType(existing.jobType);
    if (
      !(await this.registry.isMembershipActive(
        lane,
        execution.executionWorkerId,
        execution.executionMembershipEpoch,
        execution.executionNetworkEpoch,
      ))
    ) {
      throw new ConflictException('sdgb worker membership is no longer active');
    }
    return lane;
  }

  async completeMusicScoreFinalization(
    jobId: string,
    result: { syncId: string; scoreCount: number },
    body: SdgbJobPatchBody,
  ): Promise<SdgbJobView> {
    const execution = requireExecution(body);
    const now = new Date();
    const doc = await this.model.findOneAndUpdate(
      {
        id: jobId,
        jobType: 'get_music_score',
        cleanupStatus: 'succeeded',
        status: 'processing',
        executionToken: execution.executionToken,
        executionWorkerId: execution.executionWorkerId,
        executionMembershipEpoch: execution.executionMembershipEpoch,
        executionNetworkEpoch: execution.executionNetworkEpoch,
      },
      {
        $set: {
          status: 'completed',
          stage: 'persist',
          executing: false,
          result,
          error: null,
          errorCode: null,
          lastWorkerId: execution.executionWorkerId,
          executionToken: null,
          executionWorkerId: null,
          executionMembershipEpoch: null,
          executionNetworkEpoch: null,
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

  async waitForTerminal(
    jobId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<SdgbJobView> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.get(jobId);
      if (job.status === 'completed' || job.status === 'failed') {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`sdgb job ${jobId} timed out after ${timeoutMs}ms`);
  }

  private async addBullmqJob(
    jobId: string,
    jobType: SdgbJobType,
    attempt: number,
    delay = 0,
    priority?: number,
  ): Promise<void> {
    const lane = getSdgbWorkerLaneForJobType(jobType);
    await this.sdgbQueues[lane].add(
      `sdgb-${lane}-job`,
      { jobId, attempt },
      {
        jobId: this.deliveryJobId(jobId, attempt),
        priority: this.bullmqPriority(jobType, priority),
        ...(delay > 0 ? { delay } : {}),
      },
    );
  }

  private deliveryJobId(jobId: string, attempt: number): string {
    return jobId + '~' + attempt;
  }

  private mongoJobIdFromDelivery(deliveryJobId: string): string {
    const separator = deliveryJobId.lastIndexOf('~');
    return separator > 0 ? deliveryJobId.slice(0, separator) : deliveryJobId;
  }

  private ensureSdgbQueueEvents(): void {
    for (const lane of SDGB_WORKER_LANES) {
      const events = this.sdgbQueueEvents[lane];
      events.on('failed', ({ jobId, failedReason }) => {
        if (!jobId) {
          return;
        }
        this.markBullmqJobFailed(jobId, failedReason).catch((err) => {
          this.logger.warn(
            `failed to mirror sdgb ${lane} BullMQ failure for ${jobId}: ${errorMessage(
              err,
            )}`,
          );
        });
      });
      events.on('stalled', ({ jobId }) => {
        this.logger.warn(`SDGB ${lane} BullMQ job stalled job=${jobId}`);
      });
      events.on('error', (err) => {
        this.logger.warn(
          `SDGB ${lane} BullMQ queue events error: ${err.message}`,
        );
      });
    }
  }

  private bullmqPriority(jobType: SdgbJobType, priority?: number): number {
    if (getSdgbWorkerLaneForJobType(jobType) === 'probe') {
      return 10;
    }
    return toDxnetBullmqPriority(
      priority ??
        (jobType === 'scan_qr' || jobType === 'get_music_score'
          ? DXNET_PRIORITY.immediate
          : DXNET_PRIORITY.background),
    );
  }

  private async markBullmqJobFailed(
    deliveryJobId: string,
    failedReason?: string,
  ): Promise<void> {
    const jobId = this.mongoJobIdFromDelivery(deliveryJobId);
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
      const targetLane = getSdgbWorkerLaneForJobType(job.jobType);
      const targetQueue = this.sdgbQueues[targetLane];
      const deliveryJobId = this.deliveryJobId(job.id, job.attempt ?? 0);
      let activeMisplaced = false;

      for (const lane of SDGB_WORKER_LANES) {
        if (lane === targetLane) {
          continue;
        }
        const misplaced =
          (await this.sdgbQueues[lane].getJob(deliveryJobId)) ??
          (await this.sdgbQueues[lane].getJob(job.id));
        if (!misplaced) {
          continue;
        }
        const state = await misplaced.getState();
        if (state === 'active') {
          activeMisplaced = true;
          this.logger.warn(
            `cannot move active sdgb job ${job.id} from ${lane} to ${targetLane}`,
          );
          continue;
        }
        await misplaced.remove();
        this.logger.warn(
          `removed misplaced sdgb job ${job.id} from ${lane} queue`,
        );
      }

      if (activeMisplaced) {
        continue;
      }

      const existing =
        (await targetQueue.getJob(deliveryJobId)) ??
        (await targetQueue.getJob(job.id));
      if (existing) {
        const state = await existing.getState();
        if (state !== 'failed' && state !== 'completed') {
          continue;
        }
        await existing.remove();
      }

      try {
        await this.addBullmqJob(
          job.id,
          job.jobType,
          job.attempt ?? 0,
          Math.max(0, (job.retryAt?.getTime() ?? Date.now()) - Date.now()),
          job.priority,
        );
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
      this.logger.warn(
        `repaired ${repaired} missing or misrouted sdgb BullMQ jobs`,
      );
    }
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}
