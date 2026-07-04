import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';

import {
  PROBER_EXPORT_QUEUE_NAME,
  type ProberExportJobData,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';
import { ProberExportService } from './prober-export.service';

function getPositiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

@Injectable()
export class ProberExportWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ProberExportWorkerService.name);
  private readonly concurrency: number;
  private worker: Worker<ProberExportJobData> | null = null;

  constructor(
    private readonly exports: ProberExportService,
    private readonly config: ConfigService,
  ) {
    this.concurrency = getPositiveInt(config, 'PROBER_EXPORT_CONCURRENCY', 32);
  }

  onModuleInit(): void {
    const queueOptions = createBullmqQueueOptions(this.config);
    this.worker = new Worker<ProberExportJobData>(
      PROBER_EXPORT_QUEUE_NAME,
      async (job) => {
        await this.exports.process(job.data.jobId);
      },
      {
        connection: queueOptions.connection,
        prefix: queueOptions.prefix,
        concurrency: this.concurrency,
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.warn(
        `Prober export BullMQ job failed id=${job?.id}: ${err.message}`,
      );
    });
    this.logger.log(
      `Prober export worker started (concurrency=${this.concurrency})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }
}
