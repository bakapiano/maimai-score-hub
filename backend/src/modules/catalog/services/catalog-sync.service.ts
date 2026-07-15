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

import type {
  RedisLeaseContext,
  RedisLeaseOptions,
} from '../../../common/redis/redis-lease.service';
import { RedisLeaseService } from '../../../common/redis/redis-lease.service';
import { CoverService } from '../../cover/services/cover.service';
import { MusicService } from '../../music/services/music.service';

const MINUTE = 60_000;

@Injectable()
export class CatalogSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogSyncService.name);
  private cron: CronJob | null = null;

  constructor(
    private readonly music: MusicService,
    private readonly covers: CoverService,
    private readonly leases: RedisLeaseService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const expression = this.config.get<string>(
      'MUSIC_SYNC_CRON',
      CronExpression.EVERY_30_MINUTES,
    );
    this.cron = new CronJob(
      expression,
      () => {
        void this.runScheduled().catch((error: unknown) => {
          this.logger.error(
            `Scheduled catalog sync failed: ${this.errorMessage(error)}`,
            error instanceof Error ? error.stack : undefined,
          );
        });
      },
      null,
      true,
    );
    this.logger.log(`Catalog sync scheduled with cron: ${expression}`);
  }

  onModuleDestroy(): void {
    this.cron?.stop();
    this.cron = null;
  }

  async syncMusic() {
    return this.runManual(
      this.leaseOptions(
        'catalog-sync',
        this.positiveInt('MUSIC_SYNC_HARD_TIMEOUT_MS', 5 * MINUTE),
      ),
      ({ signal }) => this.music.syncMusicData(signal),
    );
  }

  async syncCovers(force: boolean) {
    const hardTimeoutMs = force
      ? this.positiveInt('COVER_FORCE_SYNC_HARD_TIMEOUT_MS', 60 * MINUTE)
      : this.positiveInt('COVER_SYNC_HARD_TIMEOUT_MS', 25 * MINUTE);
    return this.runManual(
      this.leaseOptions('catalog-sync', hardTimeoutMs),
      ({ signal }) =>
        force ? this.covers.forceSyncAll(signal) : this.covers.syncAll(signal),
    );
  }

  async backfillCoverVariants() {
    return this.runManual(
      this.leaseOptions(
        'catalog-sync',
        this.positiveInt('COVER_FORCE_SYNC_HARD_TIMEOUT_MS', 60 * MINUTE),
      ),
      ({ signal }) => this.covers.backfillLocalVariants(signal),
    );
  }

  private async runScheduled(): Promise<void> {
    const result = await this.leases.run(
      this.leaseOptions(
        'catalog-sync',
        this.positiveInt('CATALOG_SYNC_HARD_TIMEOUT_MS', 25 * MINUTE),
      ),
      async ({ signal, assertActive }) => {
        const music = await this.music.syncMusicData(signal);
        assertActive();
        const covers = await this.covers.syncAll(signal);
        return { music, covers };
      },
    );
    if (!result.acquired) {
      this.logger.log('Skipping catalog sync: another replica owns the lease');
      return;
    }
    this.logger.log(
      `Catalog sync completed: covers total=${result.value.covers.total}, saved=${result.value.covers.saved}, skipped=${result.value.covers.skipped}, failed=${result.value.covers.failed}`,
    );
  }

  private async runManual<T>(
    options: RedisLeaseOptions,
    task: (context: RedisLeaseContext) => Promise<T>,
  ): Promise<T> {
    const result = await this.leases.run(options, task);
    if (!result.acquired) {
      throw new ConflictException({
        code: 'CATALOG_SYNC_IN_PROGRESS',
        message: '曲库或封面同步正在进行中，请稍后再试',
      });
    }
    return result.value;
  }

  private leaseOptions(name: string, hardTimeoutMs: number): RedisLeaseOptions {
    return {
      name,
      ttlMs: this.positiveInt('SCHEDULER_LEASE_TTL_MS', 90_000),
      renewEveryMs: this.positiveInt(
        'SCHEDULER_LEASE_RENEW_INTERVAL_MS',
        30_000,
      ),
      hardTimeoutMs,
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
