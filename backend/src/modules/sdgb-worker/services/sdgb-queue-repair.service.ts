import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { runMaintenanceWithLease } from '../../../common/redis/redis-lease.defaults';
import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import { SdgbJobService } from './sdgb-job.service';

@Injectable()
export class SdgbQueueRepairService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SdgbQueueRepairService.name);
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly minAgeMs: number;
  private readonly batchSize: number;
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jobs: SdgbJobService,
    private readonly leases: RedisLeaseService,
    config: ConfigService,
  ) {
    this.intervalMs = positiveInt(
      config,
      'SDGB_QUEUE_REPAIR_INTERVAL_MS',
      60_000,
    );
    this.startupDelayMs = positiveInt(
      config,
      'SDGB_QUEUE_REPAIR_STARTUP_DELAY_MS',
      15_000,
    );
    this.minAgeMs = positiveInt(config, 'SDGB_QUEUE_REPAIR_MIN_AGE_MS', 30_000);
    this.batchSize = positiveInt(config, 'SDGB_QUEUE_REPAIR_BATCH_SIZE', 100);
  }

  onModuleInit(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.run().catch((error: unknown) => this.logError(error));
      this.interval = setInterval(() => {
        void this.run().catch((error: unknown) => this.logError(error));
      }, this.intervalMs);
    }, this.startupDelayMs);
  }

  onModuleDestroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
    }
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  private async run(): Promise<void> {
    await runMaintenanceWithLease(
      this.leases,
      'sdgb-queue-repair',
      ({ signal }) =>
        this.jobs.repairMissingQueuedJobs(
          this.minAgeMs,
          this.batchSize,
          signal,
        ),
    );
  }

  private logError(error: unknown): void {
    this.logger.warn(
      `SDGB queue repair failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function positiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(config.get<string | number>(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
