import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  RedisService,
  type RedisStreamEntry,
} from '../../../common/redis/redis.service';

export type WorkerLogLevel = 'log' | 'warn' | 'error';
export type WorkerLogKind = 'sdgb' | 'dxnet';

export interface WorkerLogIngestEntry {
  ts: string;
  level: WorkerLogLevel;
  message: string;
}

export interface WorkerLogQuery {
  workerKind?: WorkerLogKind;
  workerId?: string;
  level?: WorkerLogLevel;
  /** Substring match on message (case-insensitive). */
  q?: string;
  /** Lower bound on ts; default: 1h ago. */
  since?: Date;
  limit?: number;
}

export interface WorkerLogView {
  workerKind: string;
  workerId: string;
  ts: string;
  level: WorkerLogLevel;
  message: string;
}

@Injectable()
export class WorkerLogsService {
  private readonly logger = new Logger(WorkerLogsService.name);
  private readonly maxLen: number;
  private readonly maxScan: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.maxLen = this.getPositiveInt(
      config,
      'WORKER_LOG_STREAM_MAXLEN',
      50_000,
    );
    this.maxScan = this.getPositiveInt(
      config,
      'WORKER_LOG_STREAM_MAX_SCAN',
      10_000,
    );
  }

  /**
   * Bulk-insert a batch of lines from one worker. Skips invalid rows
   * silently rather than rejecting the whole batch.
   */
  async ingest(
    workerKind: WorkerLogKind,
    workerId: string,
    entries: WorkerLogIngestEntry[],
  ): Promise<{ accepted: number }> {
    if (!entries.length) return { accepted: 0 };

    const stream = this.streamKey(workerKind);
    let accepted = 0;
    for (const e of entries) {
      if (!e || typeof e.message !== 'string') continue;
      const ts = new Date(e.ts);
      if (Number.isNaN(ts.getTime())) continue;
      const level: WorkerLogLevel =
        e.level === 'warn' || e.level === 'error' ? e.level : 'log';

      try {
        await this.redis.xAddMaxLen(
          stream,
          {
            ts: ts.toISOString(),
            workerKind,
            workerId,
            level,
            message:
              e.message.length > 8192 ? e.message.slice(0, 8192) : e.message,
          },
          this.maxLen,
        );
        accepted++;
      } catch (err) {
        this.logger.warn(
          `worker-logs ingest failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return { accepted };
  }

  async list(opts: WorkerLogQuery): Promise<{
    items: WorkerLogView[];
    total: number;
  }> {
    const since = opts.since ?? new Date(Date.now() - 60 * 60 * 1000);
    const limit = Math.min(2000, Math.max(1, opts.limit ?? 500));
    const scanCount = Math.min(this.maxScan, Math.max(limit * 20, 1000));
    const q = opts.q?.trim().toLowerCase();

    const rows = await this.readKinds(opts.workerKind, scanCount);
    const filtered = rows
      .map((row) => this.toView(row))
      .filter((row): row is WorkerLogView => !!row)
      .filter((row) => new Date(row.ts).getTime() >= since.getTime())
      .filter((row) => !opts.workerId || row.workerId === opts.workerId)
      .filter((row) => !opts.level || row.level === opts.level)
      .filter((row) => !q || row.message.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
    };
  }

  /** Distinct workerIds seen recently — for the admin filter dropdown. */
  async listWorkerIds(
    sinceMs = 60 * 60 * 1000,
  ): Promise<
    Array<{ workerId: string; workerKind: string; lastSeenAt: string }>
  > {
    const since = Date.now() - sinceMs;
    const rows = await this.readKinds(undefined, this.maxScan);
    const byWorker = new Map<
      string,
      { workerId: string; workerKind: string; lastSeenAt: string }
    >();

    for (const entry of rows) {
      const view = this.toView(entry);
      if (!view) continue;
      const seenAt = new Date(view.ts).getTime();
      if (seenAt < since) continue;
      const key = `${view.workerKind}:${view.workerId}`;
      const previous = byWorker.get(key);
      if (!previous || seenAt > new Date(previous.lastSeenAt).getTime()) {
        byWorker.set(key, {
          workerId: view.workerId,
          workerKind: view.workerKind,
          lastSeenAt: view.ts,
        });
      }
    }

    return [...byWorker.values()].sort(
      (a, b) =>
        new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
    );
  }

  async countMessagesByBucket(input: {
    workerKind?: WorkerLogKind;
    since: Date;
    bucketMs: number;
    includes: string;
  }): Promise<Map<number, number>> {
    const rows = await this.readKinds(input.workerKind, this.maxScan);
    const needle = input.includes.toLowerCase();
    const sinceMs = input.since.getTime();
    const buckets = new Map<number, number>();

    for (const entry of rows) {
      const view = this.toView(entry);
      if (!view) continue;
      const ts = new Date(view.ts).getTime();
      if (ts < sinceMs) continue;
      if (!view.message.toLowerCase().includes(needle)) continue;
      const bucket = Math.floor(ts / input.bucketMs) * input.bucketMs;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }

    return buckets;
  }

  private async readKinds(kind: WorkerLogKind | undefined, count: number) {
    const kinds: WorkerLogKind[] = kind ? [kind] : ['dxnet', 'sdgb'];
    const nested = await Promise.all(
      kinds.map((k) => this.redis.xRevRange(this.streamKey(k), count)),
    );
    return nested.flat();
  }

  private streamKey(kind: WorkerLogKind): string {
    return this.redis.key(`logs:worker:${kind}`);
  }

  private toView(entry: RedisStreamEntry): WorkerLogView | null {
    const { fields } = entry;
    const level =
      fields.level === 'warn' || fields.level === 'error'
        ? fields.level
        : 'log';
    const workerKind =
      fields.workerKind === 'sdgb' || fields.workerKind === 'dxnet'
        ? fields.workerKind
        : null;
    if (!workerKind || !fields.workerId || !fields.ts) return null;

    return {
      workerKind,
      workerId: fields.workerId,
      ts: fields.ts,
      level,
      message: fields.message ?? '',
    };
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
