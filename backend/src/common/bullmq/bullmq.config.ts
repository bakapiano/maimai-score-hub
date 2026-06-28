import type { ConfigService } from '@nestjs/config';
import type { ConnectionOptions, JobsOptions, QueueOptions } from 'bullmq';

export const SDGB_WORKER_QUEUE_NAME = 'sdgb-worker-jobs';
export const PROBER_EXPORT_QUEUE_NAME = 'prober-export-jobs';

export interface DxnetWorkerJobData {
  jobId: string;
}

export interface SdgbWorkerJobData {
  jobId: string;
}

export interface ProberExportJobData {
  jobId: string;
}

function getInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string | number>(key);
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function getOptionalString(
  config: ConfigService,
  key: string,
): string | undefined {
  const raw = config.get<string>(key);
  return raw && raw.trim() ? raw.trim() : undefined;
}

export function createBullmqConnection(
  config: ConfigService,
): ConnectionOptions {
  const url = getOptionalString(config, 'REDIS_URL');
  if (url) {
    return { url, maxRetriesPerRequest: null };
  }

  const password = getOptionalString(config, 'REDIS_PASSWORD');
  return {
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: getInt(config, 'REDIS_PORT', 6379),
    db: getInt(config, 'REDIS_DB', 0),
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
  };
}

export function getBullmqPrefix(config: ConfigService): string {
  const explicit = getOptionalString(config, 'BULLMQ_PREFIX');
  if (explicit) {
    return explicit.replace(/:+$/, '');
  }

  const redisPrefix = config.get<string>('REDIS_KEY_PREFIX', 'maimai:');
  return `${redisPrefix.replace(/:+$/, '')}:bull`;
}

export function createBullmqQueueOptions(config: ConfigService): QueueOptions {
  return {
    connection: createBullmqConnection(config),
    prefix: getBullmqPrefix(config),
  };
}

export const DEFAULT_WORKER_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60, count: 1000 },
  attempts: 1,
};
