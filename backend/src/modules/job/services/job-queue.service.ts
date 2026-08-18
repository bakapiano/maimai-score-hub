import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue, QueueEvents } from 'bullmq';
import type { Model } from 'mongoose';

import {
  DXNET_EXECUTION_LANES,
  getDxnetDeliveryJobId,
  getDxnetPinnedQueueName,
  getDxnetSharedQueueName,
  parseDxnetDeliveryJobId,
  toDxnetBullmqPriority,
  type DxnetWorkerJobData,
} from '@maimai-score-hub/shared';
import {
  DEFAULT_WORKER_JOB_OPTIONS,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';
import { runMaintenanceWithLease } from '../../../common/redis/redis-lease.defaults';
import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import { RedisService } from '../../../common/redis/redis.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { JobEntity } from '../schemas/job.schema';
import { TERMINAL_STATUSES } from './job.constants';

function getPositiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type QueueRepairCursor = { createdAt: Date; id: string };

@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly queueOptions: ReturnType<typeof createBullmqQueueOptions>;
  private readonly queues = new Map<string, Queue<DxnetWorkerJobData>>();
  private readonly queueEvents = new Map<string, QueueEvents>();
  private readonly queueRepairIntervalMs: number;
  private readonly queueRepairStartupDelayMs: number;
  private readonly queueRepairMinAgeMs: number;
  private readonly queueRepairBatchSize: number;
  private readonly queueRepairScanSize: number;
  private readonly deadlineSweepIntervalMs: number;
  private queueRepairInterval: NodeJS.Timeout | null = null;
  private queueRepairStartupTimer: NodeJS.Timeout | null = null;
  private deadlineSweepInterval: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly botStatus: BotStatusService,
    private readonly leases: RedisLeaseService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.queueOptions = createBullmqQueueOptions(config);
    this.queueRepairIntervalMs = getPositiveInt(
      config,
      'DXNET_QUEUE_REPAIR_INTERVAL_MS',
      60_000,
    );
    this.queueRepairStartupDelayMs = getPositiveInt(
      config,
      'DXNET_QUEUE_REPAIR_STARTUP_DELAY_MS',
      15_000,
    );
    this.queueRepairMinAgeMs = getPositiveInt(
      config,
      'DXNET_QUEUE_REPAIR_MIN_AGE_MS',
      30_000,
    );
    this.queueRepairBatchSize = getPositiveInt(
      config,
      'DXNET_QUEUE_REPAIR_BATCH_SIZE',
      100,
    );
    this.queueRepairScanSize = getPositiveInt(
      config,
      'DXNET_QUEUE_REPAIR_SCAN_SIZE',
      Math.max(1_000, this.queueRepairBatchSize * 10),
    );
    this.deadlineSweepIntervalMs = getPositiveInt(
      config,
      'DXNET_DEADLINE_SWEEP_INTERVAL_MS',
      60_000,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.retireRemovedJobTypes();
    for (const lane of DXNET_EXECUTION_LANES) {
      this.ensureQueueEvents(getDxnetSharedQueueName(lane));
    }
    try {
      const bots = await this.botStatus.getAll();
      for (const bot of bots) {
        for (const lane of DXNET_EXECUTION_LANES) {
          this.ensureQueueEvents(getDxnetPinnedQueueName(bot.friendCode, lane));
        }
      }
    } catch (err) {
      this.logger.warn(
        `failed to initialize dxnet queue events: ${errorMessage(err)}`,
      );
    }

    this.queueRepairStartupTimer = setTimeout(() => {
      this.queueRepairStartupTimer = null;
      void this.runQueueRepair();
      this.queueRepairInterval = setInterval(
        () => void this.runQueueRepair(),
        this.queueRepairIntervalMs,
      );
    }, this.queueRepairStartupDelayMs);
    this.deadlineSweepInterval = setInterval(
      () => void this.runDeadlineSweep(),
      this.deadlineSweepIntervalMs,
    );
  }

  private async retireRemovedJobTypes(): Promise<void> {
    const result = await this.jobModel.updateMany(
      {
        jobType: 'get_user_recent_event',
        status: { $nin: TERMINAL_STATUSES },
      },
      {
        $set: {
          status: 'canceled',
          runAt: null,
          completionPending: false,
          error: 'job type removed; replaced by targeted update_score',
          updatedAt: new Date(),
        },
      },
    );
    if (result.modifiedCount) {
      this.logger.warn(
        `retired ${result.modifiedCount} legacy recent-event jobs`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queueRepairStartupTimer) {
      clearTimeout(this.queueRepairStartupTimer);
    }
    if (this.queueRepairInterval) {
      clearInterval(this.queueRepairInterval);
    }
    if (this.deadlineSweepInterval) {
      clearInterval(this.deadlineSweepInterval);
    }
    await Promise.all([
      ...[...this.queues.values()].map((queue) => queue.close()),
      ...[...this.queueEvents.values()].map((events) => events.close()),
    ]);
  }

  async enqueueWorkerJob(job: JobEntity): Promise<void> {
    if (TERMINAL_STATUSES.includes(job.status)) {
      return;
    }
    await this.enqueueV2(job);
  }

  async promoteOrEnqueueWorkerJob(job: JobEntity): Promise<void> {
    if (TERMINAL_STATUSES.includes(job.status)) {
      return;
    }
    const { queueName, deliveryId } = this.deliveryTarget(job);
    const queue = this.getQueue(queueName);
    const queued = await queue.getJob(deliveryId);
    if (queued) {
      const state = await queued.getState();
      if (state === 'delayed') {
        await queued.promote();
        return;
      }
      if (state !== 'failed' && state !== 'completed') {
        return;
      }
      await queued.remove();
    }
    await this.enqueueWorkerJob(job);
  }

  async removeCurrentDelivery(job: JobEntity): Promise<void> {
    const { queueName, deliveryId } = this.deliveryTarget(job);
    const queued = await this.getQueue(queueName).getJob(deliveryId);
    if (!queued) {
      return;
    }
    const state = await queued.getState();
    if (state !== 'active') {
      await queued.remove();
    }
  }

  private async enqueueV2(job: JobEntity): Promise<void> {
    const routing = job.routing;
    if (!routing || routing.version !== 2) {
      throw new Error(`DXNet job ${job.id} has invalid v2 routing`);
    }
    const { queueName, deliveryId } = this.deliveryTarget(job);
    const delay = job.runAt ? Math.max(0, job.runAt.getTime() - Date.now()) : 0;
    await this.getQueue(queueName).add(
      'dxnet-v2-job',
      { jobId: job.id, deliveryEpoch: routing.deliveryEpoch },
      {
        jobId: deliveryId,
        delay,
        priority: toDxnetBullmqPriority(job.priority),
      },
    );
  }

  private deliveryTarget(job: JobEntity): {
    queueName: string;
    deliveryId: string;
  } {
    const routing = job.routing;
    if (routing?.version !== 2) {
      throw new Error(`DXNet job ${job.id} has no routing v2 metadata`);
    }
    const queueName =
      routing.deliveryMode === 'shared'
        ? getDxnetSharedQueueName(routing.lane)
        : job.botUserFriendCode
          ? getDxnetPinnedQueueName(job.botUserFriendCode, routing.lane)
          : null;
    if (!queueName) {
      throw new Error(`DXNet pinned job ${job.id} has no botUserFriendCode`);
    }
    return {
      queueName,
      deliveryId: getDxnetDeliveryJobId(job.id, routing.deliveryEpoch),
    };
  }

  private getQueue(queueName: string): Queue<DxnetWorkerJobData> {
    const existing = this.queues.get(queueName);
    if (existing) {
      return existing;
    }
    const queue = new Queue<DxnetWorkerJobData>(queueName, {
      ...this.queueOptions,
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
    this.queues.set(queueName, queue);
    this.ensureQueueEvents(queueName);
    return queue;
  }

  private ensureQueueEvents(queueName: string): void {
    if (this.queueEvents.has(queueName)) {
      return;
    }
    const events = new QueueEvents(queueName, this.queueOptions);
    events.on('failed', ({ jobId, failedReason }) => {
      if (!jobId) {
        return;
      }
      void this.markBullmqJobFailed(jobId, failedReason).catch((err) => {
        this.logger.warn(
          `failed to mirror BullMQ failure for ${queueName}/${jobId}: ${errorMessage(err)}`,
        );
      });
    });
    events.on('stalled', ({ jobId }) => {
      this.logger.warn(
        `DXNet BullMQ job stalled queue=${queueName} job=${jobId}`,
      );
    });
    events.on('error', (err) => {
      this.logger.warn(
        `DXNet BullMQ queue events error queue=${queueName}: ${err.message}`,
      );
    });
    this.queueEvents.set(queueName, events);
  }

  private async markBullmqJobFailed(
    deliveryJobId: string,
    failedReason?: string,
  ): Promise<void> {
    const parsed = parseDxnetDeliveryJobId(deliveryJobId);
    if (!parsed) {
      this.logger.warn(`Ignoring malformed DXNet delivery id ${deliveryJobId}`);
      return;
    }
    await this.jobModel.updateOne(
      {
        id: parsed.jobId,
        'routing.version': 2,
        'routing.deliveryEpoch': parsed.deliveryEpoch,
        completionPending: { $ne: true },
        status: { $nin: TERMINAL_STATUSES },
      },
      {
        $set: {
          status: 'failed',
          runAt: null,
          error: failedReason || 'BullMQ job failed',
          updatedAt: new Date(),
        },
      },
    );
  }

  private async runQueueRepair(): Promise<void> {
    await runMaintenanceWithLease(
      this.leases,
      'dxnet-queue-repair',
      ({ signal }) => this.repairMissingQueuedJobs(signal),
    ).catch((err) => {
      this.logger.warn(`dxnet queue repair failed: ${errorMessage(err)}`);
    });
  }

  private async repairMissingQueuedJobs(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cutoff = new Date(Date.now() - this.queueRepairMinAgeMs);
    const cursorKey = this.redis.key('dxnet:queue-repair-cursor');
    const cursor = await this.loadQueueRepairCursor(cursorKey);
    const jobs = await this.findQueueRepairCandidates(cutoff, cursor);
    let repaired = 0;
    let lastScanned: JobEntity | null = null;
    for (const snapshot of jobs) {
      if (repaired >= this.queueRepairBatchSize) {
        break;
      }
      signal?.throwIfAborted();
      lastScanned = snapshot;
      if (await this.repairQueuedJob(snapshot)) {
        repaired += 1;
      }
    }
    if (repaired > 0) {
      this.logger.warn(`repaired ${repaired} missing dxnet BullMQ jobs`);
    }
    await this.persistQueueRepairCursor(
      cursorKey,
      jobs.length,
      repaired,
      lastScanned,
    );
  }

  private async loadQueueRepairCursor(
    cursorKey: string,
  ): Promise<QueueRepairCursor | null> {
    const rawCursor = await this.redis.getJson<{
      createdAt?: string;
      id?: string;
    }>(cursorKey);
    const cursorDate = rawCursor?.createdAt
      ? new Date(rawCursor.createdAt)
      : null;
    const cursor =
      cursorDate &&
      Number.isFinite(cursorDate.getTime()) &&
      typeof rawCursor?.id === 'string'
        ? { createdAt: cursorDate, id: rawCursor.id }
        : null;
    return cursor;
  }

  private async findQueueRepairCandidates(
    cutoff: Date,
    cursor: QueueRepairCursor | null,
  ): Promise<JobEntity[]> {
    return this.jobModel
      .find({
        'routing.version': 2,
        status: 'queued',
        ...(cursor
          ? {
              $or: [
                { createdAt: { $gt: cursor.createdAt, $lte: cutoff } },
                {
                  createdAt: cursor.createdAt,
                  id: { $gt: cursor.id },
                },
              ],
            }
          : { createdAt: { $lte: cutoff } }),
      })
      .sort({ createdAt: 1, id: 1 })
      .limit(this.queueRepairScanSize)
      .lean<JobEntity[]>();
  }

  private async repairQueuedJob(snapshot: JobEntity): Promise<boolean> {
    try {
      const { queueName, deliveryId } = this.deliveryTarget(snapshot);
      const existing = await this.getQueue(queueName).getJob(deliveryId);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'failed' && state !== 'completed') {
          return false;
        }
        await existing.remove();
      }
      if (snapshot.routing?.version !== 2) {
        return false;
      }
      const nextEpoch = snapshot.routing.deliveryEpoch + 1;
      const clearClaim = snapshot.routing.deliveryMode === 'shared';
      const updated = await this.jobModel.findOneAndUpdate(
        {
          id: snapshot.id,
          status: 'queued',
          'routing.version': 2,
          'routing.deliveryEpoch': snapshot.routing.deliveryEpoch,
        },
        {
          $set: {
            'routing.deliveryEpoch': nextEpoch,
            execution: null,
            ...(clearClaim
              ? {
                  botUserFriendCode: null,
                  'cabinetFriendship.status':
                    snapshot.cabinetFriendship?.status === 'not_required'
                      ? 'not_required'
                      : 'pending',
                  'cabinetFriendship.botFriendCode': null,
                  'cabinetFriendship.deliveryEpoch': null,
                  'cabinetFriendship.attemptsStarted': null,
                  'cabinetFriendship.sdgbJobId': null,
                  'cabinetFriendship.lastError': null,
                }
              : {}),
            updatedAt: new Date(),
          },
        },
        { new: true },
      );
      if (!updated) {
        return false;
      }
      await this.enqueueWorkerJob(updated.toObject() as JobEntity);
      return true;
    } catch (err) {
      this.logger.warn(
        `failed to repair missing dxnet BullMQ job ${snapshot.id}: ${errorMessage(err)}`,
      );
      return false;
    }
  }

  private async persistQueueRepairCursor(
    cursorKey: string,
    scannedCount: number,
    repairedCount: number,
    lastScanned: JobEntity | null,
  ): Promise<void> {
    const hasMore =
      scannedCount >= this.queueRepairScanSize ||
      repairedCount >= this.queueRepairBatchSize;
    if (lastScanned && hasMore) {
      await this.redis.setJson(
        cursorKey,
        {
          createdAt: lastScanned.createdAt.toISOString(),
          id: lastScanned.id,
        },
        { ttlSeconds: 24 * 60 * 60 },
      );
    } else {
      await this.redis.del(cursorKey);
    }
  }

  private async runDeadlineSweep(): Promise<void> {
    await runMaintenanceWithLease(
      this.leases,
      'dxnet-deadline-sweep',
      ({ signal }) => this.sweepDeadlines(signal),
    ).catch((err) => {
      this.logger.warn(`dxnet deadline sweep failed: ${errorMessage(err)}`);
    });
  }

  private async sweepDeadlines(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const now = new Date();
    const jobs = await this.jobModel
      .find({
        'routing.version': 2,
        status: { $nin: TERMINAL_STATUSES },
        deadlineAt: { $lte: now },
      })
      .limit(this.queueRepairBatchSize)
      .lean<JobEntity[]>();
    for (const job of jobs) {
      signal?.throwIfAborted();
      const background = job.routing?.lane === 'background';
      const noEligibleClaimBot =
        !background &&
        job.routing?.assignmentMode === 'claim' &&
        !job.botUserFriendCode &&
        job.cabinetFriendship?.status === 'pending';
      const result = await this.jobModel.updateOne(
        {
          id: job.id,
          'routing.deliveryEpoch': job.routing?.deliveryEpoch,
          status: { $nin: TERMINAL_STATUSES },
          deadlineAt: { $lte: now },
          completionPending:
            job.completionPending === true ? true : { $ne: true },
        },
        {
          $set: {
            status: background ? 'canceled' : 'failed',
            errorCode: background
              ? null
              : noEligibleClaimBot
                ? 'cabinet_bot_unavailable'
                : 'job_deadline_exceeded',
            error: background
              ? 'Background DXNet job expired'
              : noEligibleClaimBot
                ? 'No eligible cabinet Bot became available before deadline'
                : 'DXNet job deadline exceeded',
            completionPending: false,
            runAt: null,
            updatedAt: now,
          },
        },
      );
      if (result.modifiedCount > 0) {
        await this.removeCurrentDelivery(job);
      }
    }
  }
}
