import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { CronJob } from 'cron';

import type { RedisLeaseOptions } from '../../../common/redis/redis-lease.service';
import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import {
  MusicAliasService,
  type MusicAliasSyncSummary,
} from './music-alias.service';

const MINUTE = 60_000;

@Injectable()
export class MusicAliasSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MusicAliasSyncService.name);
  private cron: CronJob | null = null;

  constructor(
    private readonly aliases: MusicAliasService,
    private readonly leases: RedisLeaseService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const expression = this.config.get<string>(
      'ALIAS_SYNC_CRON',
      CronExpression.EVERY_30_MINUTES,
    );
    this.cron = new CronJob(
      expression,
      () => {
        void this.runScheduled('cron');
      },
      null,
      true,
    );
    this.logger.log(`Alias sync scheduled with cron: ${expression}`);

    if (this.config.get<string>('ALIAS_SYNC_ON_STARTUP', 'true') === 'true') {
      void this.runScheduled('startup');
    }
  }

  onModuleDestroy(): void {
    this.cron?.stop();
    this.cron = null;
  }

  async syncNow(): Promise<MusicAliasSyncSummary> {
    const result = await this.leases.run(this.leaseOptions(), ({ signal }) =>
      this.aliases.syncAll(signal),
    );
    if (!result.acquired) {
      throw new ConflictException({
        code: 'ALIAS_SYNC_IN_PROGRESS',
        message: '曲目别名同步正在进行中，请稍后再试',
      });
    }
    return result.value;
  }

  private async runScheduled(trigger: 'startup' | 'cron'): Promise<void> {
    try {
      const result = await this.leases.run(this.leaseOptions(), ({ signal }) =>
        this.aliases.syncAll(signal),
      );
      if (!result.acquired) {
        this.logger.log(
          `Skipping ${trigger} alias sync: another replica owns the lease`,
        );
        return;
      }
      this.logger.log(`${trigger} alias sync completed`);
    } catch (error) {
      this.logger.error(
        `${trigger} alias sync failed: ${this.errorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private leaseOptions(): RedisLeaseOptions {
    return {
      name: 'alias-sync',
      ttlMs: this.positiveInt('SCHEDULER_LEASE_TTL_MS', 90_000),
      renewEveryMs: this.positiveInt(
        'SCHEDULER_LEASE_RENEW_INTERVAL_MS',
        30_000,
      ),
      hardTimeoutMs: this.positiveInt('ALIAS_SYNC_HARD_TIMEOUT_MS', 5 * MINUTE),
      abortGraceMs: this.positiveInt('SCHEDULER_ABORT_GRACE_MS', 2 * MINUTE),
    };
  }

  private positiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<string | number>(key));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
