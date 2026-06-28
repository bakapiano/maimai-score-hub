import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FriendVsSong } from '@maimai-score-hub/shared';

import { RedisService } from '../../../common/redis/redis.service';

/**
 * Job 临时缓存服务。
 * 存储 update_score 阶段的中间结果，Redis TTL 到期后自动清理。
 */
@Injectable()
export class JobTempCacheService {
  private readonly logger = new Logger(JobTempCacheService.name);
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttlSeconds = this.getPositiveInt(
      config,
      'JOB_TEMP_CACHE_TTL_SECONDS',
      60 * 60,
    );
  }

  async get(
    jobId: string,
    diff: number,
    type: number,
  ): Promise<FriendVsSong[] | null> {
    const songs = await this.redis.getJson<FriendVsSong[]>(
      this.cacheKey(jobId, diff, type),
    );

    if (songs) {
      this.logger.log(`Cache hit for job ${jobId}, diff ${diff}, type ${type}`);
    }

    return songs;
  }

  async set(jobId: string, diff: number, type: number, songs: FriendVsSong[]) {
    await this.redis.setJson(this.cacheKey(jobId, diff, type), songs, {
      ttlSeconds: this.ttlSeconds,
    });

    this.logger.log(`Cache set for job ${jobId}, diff ${diff}, type ${type}`);
  }

  async deleteByJobId(jobId: string): Promise<number> {
    const keys = await this.redis.keys(this.cacheKey(jobId, '*', '*'));
    if (!keys.length) {
      return 0;
    }

    let deleted = 0;
    for (const key of keys) {
      deleted += await this.redis.del(key);
    }

    this.logger.log(`Deleted ${deleted} cache entries for job ${jobId}`);
    return deleted;
  }

  private cacheKey(jobId: string, diff: number | '*', type: number | '*') {
    return this.redis.key(`cache:job-temp:${jobId}:${diff}:${type}`);
  }

  private getPositiveInt(
    config: ConfigService,
    key: string,
    fallback: number,
  ): number {
    const raw = config.get<string | number>(key);
    if (raw === null || raw === undefined || raw === '') {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
