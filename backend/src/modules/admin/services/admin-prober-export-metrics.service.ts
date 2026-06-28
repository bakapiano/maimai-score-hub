import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { ProberExportJobEntity } from '../../prober-export/schemas/prober-export-job.schema';

type ProberExportWindowConfig = {
  window: '24h' | '7d';
  now: number;
  windowMs: number;
  bucketMinutes: number;
  since: Date;
  bucketFmt: string;
};

type ExportBucket = {
  label: string;
  divingFish: { success: number; failed: number };
  lxns: { success: number; failed: number };
};

type ExportTotals = { success: number; failed: number; rate: number };

@Injectable()
export class AdminProberExportMetricsService {
  constructor(
    @InjectModel(ProberExportJobEntity.name)
    private readonly proberExportJobModel: Model<ProberExportJobEntity>,
  ) {}

  /**
   * Aggregated stats for prober exports (diving-fish + lxns). Source of truth:
   * prober_export_jobs.
   */
  async getProberExportMetrics(window: '24h' | '7d') {
    const config = this.getWindowConfig(window);
    const [timeline, topFailures, recentFailures] = await Promise.all([
      this.loadTimeline(config),
      this.loadTopFailures(config),
      this.loadRecentFailures(config),
    ]);

    return {
      window,
      bucketMinutes: config.bucketMinutes,
      generatedAt: new Date(config.now).toISOString(),
      totals: this.buildTotals(timeline),
      timeline,
      topFailures,
      recentFailures,
    };
  }

  private getWindowConfig(window: '24h' | '7d'): ProberExportWindowConfig {
    const now = Date.now();
    const windowMs =
      window === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const bucketMinutes = window === '24h' ? 60 : 60 * 6;
    return {
      window,
      now,
      windowMs,
      bucketMinutes,
      since: new Date(now - windowMs),
      bucketFmt: bucketMinutes >= 60 ? '%Y-%m-%d %H:00' : '%Y-%m-%d %H:%M',
    };
  }

  private async loadTimeline(
    config: ProberExportWindowConfig,
  ): Promise<ExportBucket[]> {
    const rows = await this.proberExportJobModel
      .aggregate<{
        _id: { hr: string; provider: string; status: string };
        count: number;
      }>([
        {
          $match: {
            createdAt: { $gte: config.since },
            result: { $ne: null },
          },
        },
        this.exportEntriesProjectStage(),
        { $unwind: '$entries' },
        this.exportTimelineGroupStage(config.bucketFmt),
      ])
      .exec();
    return this.toTimelineBuckets(rows);
  }

  private exportEntriesProjectStage() {
    return {
      $project: {
        createdAt: 1,
        entries: {
          $filter: {
            input: [
              { provider: 'divingFish', status: '$result.divingFish.status' },
              { provider: 'lxns', status: '$result.lxns.status' },
            ],
            as: 'e',
            cond: { $ne: ['$$e.status', null] },
          },
        },
      },
    };
  }

  private exportTimelineGroupStage(bucketFmt: string) {
    return {
      $group: {
        _id: {
          hr: {
            $dateToString: {
              format: bucketFmt,
              date: '$createdAt',
              timezone: 'Asia/Shanghai',
            },
          },
          provider: '$entries.provider',
          status: '$entries.status',
        },
        count: { $sum: 1 },
      },
    };
  }

  private toTimelineBuckets(
    rows: Array<{
      _id: { hr: string; provider: string; status: string };
      count: number;
    }>,
  ): ExportBucket[] {
    const bucketMap = new Map<string, ExportBucket>();
    for (const row of rows) {
      const bucket = this.ensureTimelineBucket(bucketMap, row._id.hr);
      const provider = row._id.provider as 'divingFish' | 'lxns';
      const status = row._id.status as 'success' | 'failed';
      if (status === 'success' || status === 'failed') {
        bucket[provider][status] += row.count;
      }
    }
    return [...bucketMap.values()].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }

  private ensureTimelineBucket(
    bucketMap: Map<string, ExportBucket>,
    label: string,
  ): ExportBucket {
    let bucket = bucketMap.get(label);
    if (!bucket) {
      bucket = {
        label,
        divingFish: { success: 0, failed: 0 },
        lxns: { success: 0, failed: 0 },
      };
      bucketMap.set(label, bucket);
    }
    return bucket;
  }

  private async loadTopFailures(config: ProberExportWindowConfig) {
    const rows = await this.proberExportJobModel
      .aggregate<{
        _id: { provider: string; message: string };
        count: number;
        lastSeen: Date;
      }>([
        {
          $match: {
            createdAt: { $gte: config.since },
            result: { $ne: null },
          },
        },
        {
          $project: {
            createdAt: 1,
            df: '$result.divingFish',
            lxns: '$result.lxns',
          },
        },
        this.failedEntriesProjectStage(),
        { $unwind: '$entries' },
        {
          $group: {
            _id: {
              provider: '$entries.provider',
              message: { $substrCP: ['$entries.message', 0, 200] },
            },
            count: { $sum: 1 },
            lastSeen: { $max: '$createdAt' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 30 },
      ])
      .exec();
    return rows.map((row) => ({
      provider: row._id.provider,
      message: row._id.message,
      count: row.count,
      lastSeenAt: row.lastSeen.toISOString(),
    }));
  }

  private failedEntriesProjectStage() {
    return {
      $project: {
        createdAt: 1,
        entries: {
          $concatArrays: [
            this.failedEntryCondition('$df', 'divingFish'),
            this.failedEntryCondition('$lxns', 'lxns'),
          ],
        },
      },
    };
  }

  private failedEntryCondition(prefix: '$df' | '$lxns', provider: string) {
    return {
      $cond: [
        { $eq: [`${prefix}.status`, 'failed'] },
        [{ provider, message: { $ifNull: [`${prefix}.message`, 'unknown'] } }],
        [],
      ],
    };
  }

  private buildTotals(timeline: ExportBucket[]): {
    divingFish: ExportTotals;
    lxns: ExportTotals;
  } {
    const totals = {
      divingFish: { success: 0, failed: 0, rate: 0 },
      lxns: { success: 0, failed: 0, rate: 0 },
    };
    for (const bucket of timeline) {
      totals.divingFish.success += bucket.divingFish.success;
      totals.divingFish.failed += bucket.divingFish.failed;
      totals.lxns.success += bucket.lxns.success;
      totals.lxns.failed += bucket.lxns.failed;
    }
    for (const key of ['divingFish', 'lxns'] as const) {
      const total = totals[key].success + totals[key].failed;
      totals[key].rate =
        total > 0 ? Math.round((totals[key].success / total) * 1000) / 10 : 0;
    }
    return totals;
  }

  private async loadRecentFailures(config: ProberExportWindowConfig) {
    const rows = await this.proberExportJobModel
      .find({
        createdAt: { $gte: config.since },
        $or: [
          { 'result.divingFish.status': 'failed' },
          { 'result.lxns.status': 'failed' },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .select({
        id: 1,
        friendCode: 1,
        trigger: 1,
        sourceJobId: 1,
        sourceTaskId: 1,
        syncId: 1,
        createdAt: 1,
        status: 1,
        result: 1,
        _id: 0,
      })
      .lean()
      .exec();
    return rows.map((row) => ({
      exportJobId: row.id,
      jobId: row.sourceJobId ?? row.id,
      sourceTaskId: row.sourceTaskId ?? null,
      syncId: row.syncId,
      friendCode: row.friendCode,
      jobType: row.trigger,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      divingFish: row.result?.divingFish ?? null,
      lxns: row.result?.lxns ?? null,
    }));
  }
}
