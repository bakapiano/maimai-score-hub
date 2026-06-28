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
  DEFAULT_WORKER_JOB_OPTIONS,
  createBullmqQueueOptions,
  type DxnetWorkerJobData,
} from '../../../common/bullmq/bullmq.config';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { getDxnetWorkerQueueName } from '@maimai-score-hub/shared';
import { JobEntity } from '../schemas/job.schema';
import { TERMINAL_STATUSES } from './job.constants';

@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly queueOptions: ReturnType<typeof createBullmqQueueOptions>;
  private readonly dxnetQueues = new Map<string, Queue<DxnetWorkerJobData>>();
  private readonly dxnetQueueEvents = new Map<string, QueueEvents>();

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly botStatus: BotStatusService,
    config: ConfigService,
  ) {
    this.queueOptions = createBullmqQueueOptions(config);
  }

  async onModuleInit(): Promise<void> {
    try {
      const bots = await this.botStatus.getAll();
      for (const bot of bots) {
        this.ensureDxnetQueueEvents(getDxnetWorkerQueueName(bot.friendCode));
      }
    } catch (err) {
      this.logger.warn(
        `failed to initialize dxnet queue events: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      ...[...this.dxnetQueues.values()].map((queue) => queue.close()),
      ...[...this.dxnetQueueEvents.values()].map((events) => events.close()),
    ]);
  }

  async enqueueWorkerJob(job: JobEntity): Promise<void> {
    if (TERMINAL_STATUSES.includes(job.status)) {
      return;
    }
    if (!job.botUserFriendCode) {
      throw new Error(`DXNet job ${job.id} has no botUserFriendCode`);
    }

    const now = Date.now();
    const delay = job.runAt ? Math.max(0, job.runAt.getTime() - now) : 0;
    await this.getDxnetQueue(job.botUserFriendCode).add(
      'dxnet-job',
      { jobId: job.id },
      {
        jobId: job.id,
        delay,
        priority: this.toBullmqPriority(job.priority ?? 0),
      },
    );
  }

  async promoteOrEnqueueWorkerJob(job: JobEntity): Promise<void> {
    if (TERMINAL_STATUSES.includes(job.status)) {
      return;
    }
    if (!job.botUserFriendCode) {
      throw new Error(`DXNet job ${job.id} has no botUserFriendCode`);
    }

    const queue = this.getDxnetQueue(job.botUserFriendCode);
    const queued = await queue.getJob(job.id);
    if (queued) {
      const state = await queued.getState();
      if (state === 'delayed') {
        await queued.promote();
      }
      return;
    }

    await this.enqueueWorkerJob(job);
  }

  private getDxnetQueue(botFriendCode: string): Queue<DxnetWorkerJobData> {
    const queueName = getDxnetWorkerQueueName(botFriendCode);
    const existing = this.dxnetQueues.get(queueName);
    if (existing) {
      return existing;
    }

    const queue = new Queue<DxnetWorkerJobData>(queueName, {
      ...this.queueOptions,
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
    this.dxnetQueues.set(queueName, queue);
    this.ensureDxnetQueueEvents(queueName);
    return queue;
  }

  private ensureDxnetQueueEvents(queueName: string): void {
    if (this.dxnetQueueEvents.has(queueName)) {
      return;
    }

    const events = new QueueEvents(queueName, this.queueOptions);
    events.on('failed', ({ jobId, failedReason }) => {
      if (!jobId) {
        return;
      }
      this.markBullmqJobFailed(jobId, failedReason).catch((err) => {
        this.logger.warn(
          `failed to mirror BullMQ failure for ${queueName}/${jobId}: ${
            err instanceof Error ? err.message : err
          }`,
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
    this.dxnetQueueEvents.set(queueName, events);
  }

  private async markBullmqJobFailed(
    jobId: string,
    failedReason?: string,
  ): Promise<void> {
    await this.jobModel.updateOne(
      { id: jobId, status: { $nin: TERMINAL_STATUSES } },
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

  private toBullmqPriority(priority: number): number | undefined {
    if (!Number.isFinite(priority) || priority <= 0) {
      return undefined;
    }
    return Math.max(1, 100 - Math.floor(priority));
  }
}
