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
import { Interval } from '@nestjs/schedule';
import { Queue, QueueEvents } from 'bullmq';
import { randomUUID } from 'crypto';
import type { Model } from 'mongoose';

import { SyncService } from '../../sync/services/sync.service';
import { UsersService } from '../../users/services/users.service';
import {
  DEFAULT_WORKER_JOB_OPTIONS,
  PROBER_EXPORT_QUEUE_NAME,
  type ProberExportJobData,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';
import {
  ProberExportJobEntity,
  type ProberExportJobDocument,
  type ProberExportProvider,
  type ProberExportProviderResult,
  type ProberExportResult,
  type ProberExportStatus,
  type ProberExportTrigger,
} from '../schemas/prober-export-job.schema';

type UserWithTokens = {
  divingFishImportToken?: string | null;
  lxnsImportToken?: string | null;
};

type SyncExportResponse = {
  status: number | string;
  reason?: string;
  scores?: number;
  exported?: number;
  skipped?: number;
  response?: unknown;
};

export type AutoExportResultMirror = {
  divingFish?: { status: string; message?: string } | null;
  lxns?: { status: string; message?: string } | null;
};

export type ProberExportJobView = {
  id: string;
  trigger: ProberExportTrigger;
  friendCode: string;
  syncId: string;
  sourceJobId: string | null;
  sourceTaskId: string | null;
  targets: ProberExportProvider[];
  status: ProberExportStatus;
  attempts: number;
  result: ProberExportResult | null;
  error: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const STALE_MS = Number(process.env.PROBER_EXPORT_STALE_MS ?? 10 * 60 * 1000);
const SWEEP_INTERVAL_MS = Number(
  process.env.PROBER_EXPORT_SWEEP_INTERVAL_MS ?? 30_000,
);
const ORPHAN_PROCESSING_MS = Number(
  process.env.PROBER_EXPORT_ORPHAN_PROCESSING_MS ?? 30_000,
);
const TERMINAL_STATUSES: ProberExportStatus[] = [
  'completed',
  'partial_failed',
  'failed',
  'skipped',
];

function toView(doc: ProberExportJobEntity): ProberExportJobView {
  return {
    id: doc.id,
    trigger: doc.trigger,
    friendCode: doc.friendCode,
    syncId: doc.syncId,
    sourceJobId: doc.sourceJobId ?? null,
    sourceTaskId: doc.sourceTaskId ?? null,
    targets: doc.targets ?? [],
    status: doc.status,
    attempts: doc.attempts ?? 0,
    result: doc.result ?? null,
    error: doc.error ?? null,
    claimedAt: doc.claimedAt?.toISOString() ?? null,
    completedAt: doc.completedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function duplicateKey(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

function isInvalidTokenError(
  target: ProberExportProvider,
  message: string,
): boolean {
  if (target === 'divingFish') {
    return /Diving-fish responded 400/i.test(message) && /token/i.test(message);
  }
  return /LXNS responded 401/i.test(message);
}

@Injectable()
export class ProberExportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProberExportService.name);
  private readonly queue: Queue<ProberExportJobData>;
  private readonly queueEvents: QueueEvents;
  private sweepRunning = false;

  constructor(
    @InjectModel(ProberExportJobEntity.name)
    private readonly model: Model<ProberExportJobDocument>,
    private readonly users: UsersService,
    private readonly syncs: SyncService,
    config: ConfigService,
  ) {
    const queueOptions = createBullmqQueueOptions(config);
    this.queue = new Queue<ProberExportJobData>(PROBER_EXPORT_QUEUE_NAME, {
      ...queueOptions,
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
    this.queueEvents = new QueueEvents(PROBER_EXPORT_QUEUE_NAME, queueOptions);
  }

  onModuleInit(): void {
    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      if (!jobId) {
        return;
      }
      this.markBullmqJobFailed(jobId, failedReason).catch((err) => {
        this.logger.warn(
          `failed to mirror prober export BullMQ failure for ${jobId}: ${errorMessage(
            err,
          )}`,
        );
      });
    });
    this.queueEvents.on('stalled', ({ jobId }) => {
      this.logger.warn(`Prober export BullMQ job stalled id=${jobId}`);
    });
    this.queueEvents.on('error', (err) => {
      this.logger.warn(`Prober export queue events error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.queueEvents.close();
  }

  async enqueueAutoExportForSync(input: {
    trigger: Exclude<ProberExportTrigger, 'manual'>;
    friendCode: string;
    syncId: string;
    sourceJobId?: string | null;
    sourceTaskId?: string | null;
  }): Promise<ProberExportJobView | null> {
    const user = await this.users.findByFriendCode(input.friendCode);
    if (!user) {
      return null;
    }
    const targets = this.resolveTargets(user);
    if (!targets.length) {
      return null;
    }

    return this.createAndQueue({
      trigger: input.trigger,
      friendCode: input.friendCode,
      syncId: input.syncId,
      sourceJobId: input.sourceJobId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
      targets,
      idempotent: true,
    });
  }

  async enqueueManualExport(input: {
    friendCode: string;
    syncId: string;
    target: ProberExportProvider;
  }): Promise<ProberExportJobView> {
    const user = await this.users.findByFriendCode(input.friendCode);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const token = this.tokenFor(user, input.target);
    if (!token) {
      throw new BadRequestException(
        input.target === 'divingFish'
          ? 'User missing divingFishImportToken'
          : 'User missing lxnsImportToken',
      );
    }

    return this.createAndQueue({
      trigger: 'manual',
      friendCode: input.friendCode,
      syncId: input.syncId,
      sourceJobId: null,
      sourceTaskId: null,
      targets: [input.target],
      idempotent: false,
    });
  }

  async getForUser(
    exportJobId: string,
    friendCode: string,
  ): Promise<ProberExportJobView> {
    const doc = await this.model
      .findOne({ id: exportJobId, friendCode })
      .lean<ProberExportJobEntity | null>();
    if (!doc) {
      throw new NotFoundException('Prober export job not found');
    }
    return toView(doc);
  }

  async getRecentForUser(
    friendCode: string,
    limit: number,
  ): Promise<ProberExportJobView[]> {
    const docs = await this.model
      .find({ friendCode })
      .sort({ createdAt: -1 })
      .limit(Math.min(100, Math.max(1, limit)))
      .lean<ProberExportJobEntity[]>();
    return docs.map(toView);
  }

  async process(jobId: string): Promise<void> {
    const now = new Date();
    const doc = await this.model
      .findOneAndUpdate(
        { id: jobId, status: 'queued' },
        {
          $set: {
            status: 'processing',
            claimedAt: now,
            updatedAt: now,
            error: null,
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .lean<ProberExportJobEntity | null>();

    if (!doc) {
      return;
    }

    let result: ProberExportResult = { ...(doc.result ?? {}) };
    let status: ProberExportStatus = 'failed';
    let error: string | null = null;

    try {
      const user = await this.users.findByFriendCode(doc.friendCode);
      if (!user) {
        throw new Error('User not found');
      }

      for (const target of doc.targets ?? []) {
        const existing = result[target];
        if (existing?.status === 'success') {
          continue;
        }
        result = {
          ...result,
          [target]: await this.exportTarget(doc, target, user),
        };
      }
      status = this.aggregateStatus(doc.targets ?? [], result);
    } catch (err) {
      error = errorMessage(err);
      status = 'failed';
    }

    const completedAt = new Date();
    await this.model.updateOne(
      { id: jobId },
      {
        $set: {
          status,
          result,
          error,
          completedAt,
          updatedAt: completedAt,
        },
      },
    );

    await this.mirrorSyncResult(doc, result).catch((err) => {
      this.logger.warn(
        `Failed to mirror prober export result to sync job=${jobId}: ${errorMessage(err)}`,
      );
    });
  }

  @Interval(SWEEP_INTERVAL_MS)
  async sweepStaleAndQueued(): Promise<void> {
    if (this.sweepRunning) {
      return;
    }
    this.sweepRunning = true;
    try {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - STALE_MS);
      const orphanBefore = new Date(now.getTime() - ORPHAN_PROCESSING_MS);
      await this.model.updateMany(
        {
          status: 'processing',
          claimedAt: { $lte: staleBefore },
        },
        {
          $set: {
            status: 'queued',
            error: 'stale export worker lock released',
            updatedAt: now,
          },
        },
      );
      await this.releaseProcessingOrphans(orphanBefore, now);

      const queued = await this.model
        .find({ status: 'queued' })
        .sort({ createdAt: 1 })
        .limit(200)
        .select({ id: 1 })
        .lean<Array<{ id: string }>>();
      await Promise.all(queued.map((job) => this.ensureBullmqJob(job.id)));
    } finally {
      this.sweepRunning = false;
    }
  }

  private async createAndQueue(input: {
    trigger: ProberExportTrigger;
    friendCode: string;
    syncId: string;
    sourceJobId: string | null;
    sourceTaskId: string | null;
    targets: ProberExportProvider[];
    idempotent: boolean;
  }): Promise<ProberExportJobView> {
    if (input.idempotent) {
      const existing = await this.findExisting(input);
      if (existing) {
        if (existing.status === 'queued') {
          await this.ensureBullmqJob(existing.id);
        }
        return toView(existing);
      }
    }

    const now = new Date();
    const id = randomUUID();
    try {
      const created = await this.model.create({
        id,
        trigger: input.trigger,
        friendCode: input.friendCode,
        syncId: input.syncId,
        sourceJobId: input.sourceJobId,
        sourceTaskId: input.sourceTaskId,
        targets: input.targets,
        status: 'queued',
        attempts: 0,
        result: null,
        error: null,
        claimedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      try {
        await this.ensureBullmqJob(id);
      } catch (err) {
        const failedAt = new Date();
        await this.model.updateOne(
          { id, status: 'queued' },
          {
            $set: {
              status: 'failed',
              error: `failed to enqueue prober export BullMQ job: ${errorMessage(
                err,
              )}`,
              completedAt: failedAt,
              updatedAt: failedAt,
            },
          },
        );
        throw err;
      }
      return toView(created.toObject() as ProberExportJobEntity);
    } catch (err) {
      if (input.idempotent && duplicateKey(err)) {
        const existing = await this.findExisting(input);
        if (existing) {
          if (existing.status === 'queued') {
            await this.ensureBullmqJob(existing.id);
          }
          return toView(existing);
        }
      }
      throw err;
    }
  }

  private async findExisting(input: {
    trigger: ProberExportTrigger;
    sourceJobId: string | null;
    sourceTaskId: string | null;
  }): Promise<ProberExportJobEntity | null> {
    if (input.sourceJobId) {
      return this.model
        .findOne({ trigger: input.trigger, sourceJobId: input.sourceJobId })
        .lean<ProberExportJobEntity | null>();
    }
    if (input.sourceTaskId) {
      return this.model
        .findOne({ trigger: input.trigger, sourceTaskId: input.sourceTaskId })
        .lean<ProberExportJobEntity | null>();
    }
    return null;
  }

  private async enqueueBullmq(jobId: string): Promise<void> {
    await this.queue.add(
      'prober-export-job',
      { jobId },
      {
        jobId,
      },
    );
  }

  private async ensureBullmqJob(jobId: string): Promise<void> {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'failed' && state !== 'completed') {
        return;
      }
      await existing.remove();
    }

    await this.enqueueBullmq(jobId);
  }

  private async markBullmqJobFailed(
    jobId: string,
    failedReason?: string,
  ): Promise<void> {
    const now = new Date();
    await this.model.updateOne(
      { id: jobId, status: { $nin: TERMINAL_STATUSES } },
      {
        $set: {
          status: 'failed',
          error: failedReason || 'BullMQ job failed',
          completedAt: now,
          updatedAt: now,
        },
      },
    );
  }

  private async releaseProcessingOrphans(
    orphanBefore: Date,
    now: Date,
  ): Promise<void> {
    const processing = await this.model
      .find({ status: 'processing', claimedAt: { $lte: orphanBefore } })
      .sort({ claimedAt: 1 })
      .limit(200)
      .select({ id: 1 })
      .lean<Array<{ id: string }>>();

    let released = 0;
    for (const job of processing) {
      const existing = await this.queue.getJob(job.id);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'failed' && state !== 'completed') {
          continue;
        }
        await existing.remove();
      }

      const result = await this.model.updateOne(
        { id: job.id, status: 'processing' },
        {
          $set: {
            status: 'queued',
            error: 'orphan export worker lock released',
            claimedAt: null,
            updatedAt: now,
          },
        },
      );
      if (result.modifiedCount > 0) {
        released += 1;
      }
    }

    if (released > 0) {
      this.logger.warn(`released ${released} orphan prober export jobs`);
    }
  }

  private resolveTargets(user: UserWithTokens): ProberExportProvider[] {
    const targets: ProberExportProvider[] = [];
    if (user.divingFishImportToken) {
      targets.push('divingFish');
    }
    if (user.lxnsImportToken) {
      targets.push('lxns');
    }
    return targets;
  }

  private tokenFor(
    user: UserWithTokens,
    target: ProberExportProvider,
  ): string | null {
    return target === 'divingFish'
      ? (user.divingFishImportToken ?? null)
      : (user.lxnsImportToken ?? null);
  }

  private async exportTarget(
    job: ProberExportJobEntity,
    target: ProberExportProvider,
    user: UserWithTokens,
  ): Promise<ProberExportProviderResult> {
    const token = this.tokenFor(user, target);
    if (!token) {
      return {
        status: 'failed',
        message:
          target === 'divingFish'
            ? 'User missing divingFishImportToken'
            : 'User missing lxnsImportToken',
      };
    }

    try {
      const response =
        target === 'divingFish'
          ? await this.syncs.exportSyncToDivingFish({
              friendCode: job.friendCode,
              syncId: job.syncId,
              importToken: token,
            })
          : await this.syncs.exportSyncToLxns({
              friendCode: job.friendCode,
              syncId: job.syncId,
              importToken: token,
            });
      return this.toProviderResult(response);
    } catch (err) {
      const message = errorMessage(err);
      if (isInvalidTokenError(target, message)) {
        await this.users.clearProberImportToken(job.friendCode, target);
        return {
          status: 'failed',
          message: `${message}，已清除失效 token，请重新配置后再试。`,
        };
      }
      return { status: 'failed', message };
    }
  }

  private toProviderResult(
    response: SyncExportResponse,
  ): ProberExportProviderResult {
    if (response.status === 'skipped') {
      return {
        status: 'skipped',
        message: response.reason ?? 'skipped',
        scores: response.scores,
        exported: response.exported,
        skipped: response.skipped,
        response: response.response,
      };
    }

    return {
      status: 'success',
      message: `导出 ${response.exported ?? 0} 条成绩`,
      scores: response.scores,
      exported: response.exported,
      skipped: response.skipped,
      response: response.response,
    };
  }

  private aggregateStatus(
    targets: ProberExportProvider[],
    result: ProberExportResult,
  ): ProberExportStatus {
    const entries = targets
      .map((target) => result[target])
      .filter((entry): entry is ProberExportProviderResult => !!entry);
    if (!entries.length) {
      return 'skipped';
    }
    if (entries.every((entry) => entry.status === 'skipped')) {
      return 'skipped';
    }
    if (entries.every((entry) => entry.status === 'failed')) {
      return 'failed';
    }
    if (entries.some((entry) => entry.status === 'failed')) {
      return 'partial_failed';
    }
    return 'completed';
  }

  private async mirrorSyncResult(
    job: ProberExportJobEntity,
    result: ProberExportResult,
  ): Promise<void> {
    if (job.trigger === 'manual') {
      return;
    }

    const mirror = this.toMirror(result);
    await this.syncs.updateAutoExportResultBySyncId(job.syncId, mirror);
  }

  private toMirror(result: ProberExportResult): AutoExportResultMirror {
    return {
      divingFish: result.divingFish
        ? {
            status: result.divingFish.status,
            message: result.divingFish.message,
          }
        : null,
      lxns: result.lxns
        ? {
            status: result.lxns.status,
            message: result.lxns.message,
          }
        : null,
    };
  }
}
