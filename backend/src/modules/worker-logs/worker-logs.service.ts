import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import {
  WorkerLogEntity,
  type WorkerLogDocument,
  type WorkerLogLevel,
} from './worker-log.schema';

export interface WorkerLogIngestEntry {
  ts: string;
  level: WorkerLogLevel;
  message: string;
}

export interface WorkerLogQuery {
  workerKind?: 'sdgb' | 'dxnet';
  workerId?: string;
  level?: WorkerLogLevel;
  /** Substring match on message (case-insensitive). */
  q?: string;
  /** Lower bound on ts; default: 1h ago. */
  since?: Date;
  limit?: number;
}

@Injectable()
export class WorkerLogsService {
  private readonly logger = new Logger(WorkerLogsService.name);

  constructor(
    @InjectModel(WorkerLogEntity.name)
    private readonly model: Model<WorkerLogDocument>,
  ) {}

  /**
   * Bulk-insert a batch of lines from one worker. Skips invalid rows
   * silently rather than rejecting the whole batch — workers should never
   * stop sending logs because of a single malformed entry.
   */
  async ingest(
    workerKind: 'sdgb' | 'dxnet',
    workerId: string,
    entries: WorkerLogIngestEntry[],
  ): Promise<{ accepted: number }> {
    if (!entries.length) return { accepted: 0 };
    const docs: Partial<WorkerLogEntity>[] = [];
    for (const e of entries) {
      if (!e || typeof e.message !== 'string') continue;
      const ts = new Date(e.ts);
      if (Number.isNaN(ts.getTime())) continue;
      const level: WorkerLogLevel =
        e.level === 'warn' || e.level === 'error' ? e.level : 'log';
      docs.push({
        workerId,
        workerKind,
        ts,
        level,
        // Cap at 8KB so a runaway log line can't blow up our docs.
        message: e.message.length > 8192 ? e.message.slice(0, 8192) : e.message,
      });
    }
    if (!docs.length) return { accepted: 0 };
    try {
      await this.model.insertMany(docs, { ordered: false });
    } catch (err) {
      // ordered:false → Mongo still inserts the rest; just log.
      this.logger.warn(
        `worker-logs ingest had partial failure: ${err instanceof Error ? err.message : err}`,
      );
    }
    return { accepted: docs.length };
  }

  async list(opts: WorkerLogQuery): Promise<{
    items: Array<{
      workerKind: string;
      workerId: string;
      ts: string;
      level: WorkerLogLevel;
      message: string;
    }>;
    total: number;
  }> {
    const filter: Record<string, unknown> = {};
    if (opts.workerKind) filter.workerKind = opts.workerKind;
    if (opts.workerId) filter.workerId = opts.workerId;
    if (opts.level) filter.level = opts.level;
    if (opts.q && opts.q.trim()) {
      const safe = opts.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.message = { $regex: safe, $options: 'i' };
    }
    const since = opts.since ?? new Date(Date.now() - 60 * 60 * 1000);
    filter.ts = { $gte: since };

    const limit = Math.min(2000, Math.max(1, opts.limit ?? 500));
    // Sort newest first so the UI can show the tail without paging.
    const docs = await this.model
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .lean();
    const total = await this.model.countDocuments(filter);
    return {
      items: docs.map((d) => ({
        workerKind: d.workerKind,
        workerId: d.workerId,
        ts: d.ts.toISOString(),
        level: d.level,
        message: d.message,
      })),
      total,
    };
  }

  /** Distinct workerIds seen recently — for the admin filter dropdown. */
  async listWorkerIds(sinceMs = 60 * 60 * 1000): Promise<
    Array<{ workerId: string; workerKind: string; lastSeenAt: string }>
  > {
    const since = new Date(Date.now() - sinceMs);
    const rows = await this.model.aggregate<{
      _id: { workerId: string; workerKind: string };
      lastSeenAt: Date;
    }>([
      { $match: { ts: { $gte: since } } },
      {
        $group: {
          _id: { workerId: '$workerId', workerKind: '$workerKind' },
          lastSeenAt: { $max: '$ts' },
        },
      },
      { $sort: { lastSeenAt: -1 } },
    ]);
    return rows.map((r) => ({
      workerId: r._id.workerId,
      workerKind: r._id.workerKind,
      lastSeenAt: r.lastSeenAt.toISOString(),
    }));
  }
}
