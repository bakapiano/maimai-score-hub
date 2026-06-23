import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RedisService } from '../../../common/redis/redis.service';

export interface ApiLogEntry {
  url: string;
  method: string;
  statusCode: number;
  bodySize?: number | null;
}

export interface ApiLogResponse {
  url: string;
  method: string;
  statusCode: number;
  bodySize: number | null;
  createdAt: string;
}

interface StoredApiLog {
  url: string;
  method: string;
  statusCode: number;
  bodySize: number | null;
  createdAt: string;
}

@Injectable()
export class JobApiLogService {
  private readonly ttlSeconds: number;
  private readonly maxEntriesPerJob: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttlSeconds = this.getPositiveInt(
      config,
      'API_DEBUG_TTL_SECONDS',
      24 * 60 * 60,
    );
    this.maxEntriesPerJob = this.getPositiveInt(
      config,
      'API_DEBUG_MAX_ENTRIES',
      500,
    );
  }

  async saveLogs(jobId: string, logs: ApiLogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    const key = this.apiLogKey(jobId);
    const existing = (await this.redis.getJson<StoredApiLog[]>(key)) ?? [];
    const now = new Date();
    const next = existing.concat(
      logs.map((log) => ({
        url: log.url,
        method: log.method,
        statusCode: log.statusCode,
        bodySize:
          typeof log.bodySize === 'number' && Number.isFinite(log.bodySize)
            ? Math.max(0, Math.floor(log.bodySize))
            : null,
        createdAt: now.toISOString(),
      })),
    );

    await this.redis.setJson(key, next.slice(-this.maxEntriesPerJob), {
      ttlSeconds: this.ttlSeconds,
    });
  }

  async getLogsByJobId(jobId: string): Promise<ApiLogResponse[]> {
    return (
      (await this.redis.getJson<ApiLogResponse[]>(this.apiLogKey(jobId))) ?? []
    );
  }

  private apiLogKey(jobId: string): string {
    return this.redis.key(`debug:api:${jobId}`);
  }

  private getPositiveInt(
    config: ConfigService,
    key: string,
    fallback: number,
  ): number {
    const raw = config.get<string | number>(key);
    if (raw == null || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
