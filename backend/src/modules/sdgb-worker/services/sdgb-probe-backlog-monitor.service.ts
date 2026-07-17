import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { runMaintenanceWithLease } from '../../../common/redis/redis-lease.defaults';
import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import {
  SdgbJobEntity,
  type SdgbJobDocument,
} from '../schemas/sdgb-job.schema';

@Injectable()
export class SdgbProbeBacklogMonitorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SdgbProbeBacklogMonitorService.name);
  private readonly warningMs: number;
  private readonly criticalMs: number;
  private interval: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(SdgbJobEntity.name)
    private readonly model: Model<SdgbJobDocument>,
    private readonly leases: RedisLeaseService,
    config: ConfigService,
  ) {
    this.warningMs = positiveInt(
      config.get<string | number>('SDGB_PROBE_BACKLOG_WARNING_MS'),
      15 * 60_000,
    );
    this.criticalMs = positiveInt(
      config.get<string | number>('SDGB_PROBE_BACKLOG_CRITICAL_MS'),
      30 * 60_000,
    );
  }

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.check().catch((error: unknown) => {
        this.logger.warn(
          'Probe backlog check failed: ' +
            (error instanceof Error ? error.message : String(error)),
        );
      });
    }, 60_000);
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    await runMaintenanceWithLease(
      this.leases,
      'sdgb-probe-backlog-monitor',
      async ({ signal }) => {
        signal.throwIfAborted();
        const oldest = await this.model
          .findOne({ status: 'queued', lane: 'probe' })
          .sort({ createdAt: 1 })
          .lean<SdgbJobEntity>();
        if (!oldest) {
          return;
        }
        const ageMs = Date.now() - oldest.createdAt.getTime();
        if (ageMs >= this.criticalMs) {
          this.logger.error('SDGB Probe backlog critical oldestAgeMs=' + ageMs);
        } else if (ageMs >= this.warningMs) {
          this.logger.warn('SDGB Probe backlog warning oldestAgeMs=' + ageMs);
        }
      },
    );
  }
}

function positiveInt(value: string | number | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
