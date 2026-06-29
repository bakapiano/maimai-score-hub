import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { AutoUpdateRunEntity } from '../../auto-update/schemas/auto-update-run.schema';
import { BotStatusEntity } from '../../bots/schemas/bot-status.schema';
import { JobEntity } from '../../job/schemas/job.schema';
import { ClickHouseService } from '../../observability/services/clickhouse.service';
import {
  getObservabilityEnvironment,
  type ObservabilityEnvironment,
} from '../../observability/services/observability-env';
import { UserEntity } from '../../users/schemas/user.schema';

type AutoUpdateWindowConfig = {
  window: '24h' | '7d';
  now: number;
  windowMs: number;
  bucketMinutes: number;
  bucketMs: number;
  since: Date;
};

type AutoUpdateRunBucket = {
  bucketStart: string;
  triggered: number;
  skipped: number;
  failed: number;
  sweepCount: number;
};

type AutoUpdateDurationBucket = {
  bucketStart: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p99Ms: number;
};

type AutoUpdateTimelineBucket = AutoUpdateRunBucket & {
  completedJobs: number;
  avgDurationMs: number | null;
  p50Ms: number | null;
  p99Ms: number | null;
  rateLimit567: number;
};

type AutoUpdateCurrentSnapshot = {
  autoUpdateUsers: number;
  queued: number;
  processing: number;
  perBotInflight: Array<{ friendCode: string; count: number }>;
  activeCabinetBots: number;
};

@Injectable()
export class AdminAutoUpdateMetricsService {
  private readonly environment: ObservabilityEnvironment;

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @InjectModel(BotStatusEntity.name)
    private readonly botStatusModel: Model<BotStatusEntity>,
    @InjectModel(AutoUpdateRunEntity.name)
    private readonly autoUpdateRunModel: Model<AutoUpdateRunEntity>,
    @InjectModel(UserEntity.name)
    private readonly userModel: Model<UserEntity>,
    private readonly clickhouse: ClickHouseService,
    config: ConfigService,
  ) {
    this.environment = getObservabilityEnvironment(config);
  }

  /**
   * Aggregated dashboard for the auto-update subsystem. Returns:
   *   - timeline buckets: triggered / skippedHashUnchanged / skippedThrottled
   *     / failed counts per bucket (5min for 24h window, 1h for 7d window)
   *   - duration trend per bucket: avg, p50, p99 of updateScoreDuration
   *   - 567 rate-limit hits per bucket (from ClickHouse external_api_calls)
   *   - "now" snapshot: queued + processing counts, per-bot inflight,
   *     active auto-update user count
   *   - capacity estimate: throughput vs current load
   */
  async getAutoUpdateMetrics(window: '24h' | '7d') {
    const config = this.getWindowConfig(window);
    const [bucketMap, durationBuckets, limitByBucket, snapshot] =
      await Promise.all([
        this.loadRunBucketMap(config),
        this.loadDurationBuckets(config),
        this.countRateLimitLogsByBucket(config.since, config.bucketMs),
        this.loadCurrentSnapshot(),
      ]);
    const timeline = this.buildTimeline(
      config,
      bucketMap,
      durationBuckets,
      limitByBucket,
    );
    const capacity = this.buildCapacity(timeline, snapshot);
    const totalTriggered = timeline.reduce((s, b) => s + b.triggered, 0);
    const totalSkipped = timeline.reduce((s, b) => s + b.skipped, 0);
    const totalSweepCount = timeline.reduce((s, b) => s + b.sweepCount, 0);

    return {
      window,
      bucketMinutes: config.bucketMinutes,
      generatedAt: new Date(config.now).toISOString(),
      timeline,
      now: snapshot,
      capacity,
      summary: {
        totalTriggered,
        totalSkipped,
        totalSweepCount,
        total567: timeline.reduce((s, b) => s + b.rateLimit567, 0),
      },
    };
  }

  private getWindowConfig(window: '24h' | '7d'): AutoUpdateWindowConfig {
    const now = Date.now();
    const windowMs =
      window === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const bucketMinutes = window === '24h' ? 5 : 60;
    const bucketMs = bucketMinutes * 60 * 1000;
    return {
      window,
      now,
      windowMs,
      bucketMinutes,
      bucketMs,
      since: new Date(now - windowMs),
    };
  }

  private bucketKey(d: Date | number, bucketMs: number): number {
    return (
      Math.floor((d instanceof Date ? d.getTime() : d) / bucketMs) * bucketMs
    );
  }

  private async loadRunBucketMap(
    config: AutoUpdateWindowConfig,
  ): Promise<Map<number, AutoUpdateRunBucket>> {
    const runDocs = await this.autoUpdateRunModel
      .find({ triggeredAt: { $gte: config.since } })
      .select({
        triggeredAt: 1,
        triggered: 1,
        skippedNoChange: 1,
        failed: 1,
        totalUsers: 1,
      })
      .lean()
      .exec();
    const bucketMap = new Map<number, AutoUpdateRunBucket>();
    for (const r of runDocs) {
      if (!r.triggeredAt) {
        continue;
      }
      const key = this.bucketKey(r.triggeredAt, config.bucketMs);
      const bucket = this.ensureRunBucket(bucketMap, key);
      bucket.triggered += r.triggered ?? 0;
      bucket.skipped += r.skippedNoChange ?? 0;
      bucket.failed += r.failed ?? 0;
      bucket.sweepCount += 1;
    }
    return bucketMap;
  }

  private ensureRunBucket(
    bucketMap: Map<number, AutoUpdateRunBucket>,
    key: number,
  ): AutoUpdateRunBucket {
    let bucket = bucketMap.get(key);
    if (!bucket) {
      bucket = {
        bucketStart: new Date(key).toISOString(),
        triggered: 0,
        skipped: 0,
        failed: 0,
        sweepCount: 0,
      };
      bucketMap.set(key, bucket);
    }
    return bucket;
  }

  private async loadDurationBuckets(
    config: AutoUpdateWindowConfig,
  ): Promise<AutoUpdateDurationBucket[]> {
    const rows = await this.jobModel
      .aggregate<{
        _id: Date;
        avg: number;
        count: number;
        durations: number[];
      }>([
        {
          $match: {
            jobType: 'update_score',
            status: 'completed',
            updateScoreDuration: { $ne: null, $gt: 0 },
            createdAt: { $gte: config.since },
          },
        },
        {
          $group: {
            _id: {
              $dateTrunc: {
                date: '$createdAt',
                unit: 'minute',
                binSize: config.bucketMinutes,
              },
            },
            avg: { $avg: '$updateScoreDuration' },
            count: { $sum: 1 },
            durations: { $push: '$updateScoreDuration' },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();
    return rows.map((row) => this.toDurationBucket(row));
  }

  private toDurationBucket(row: {
    _id: Date;
    avg: number;
    count: number;
    durations: number[];
  }): AutoUpdateDurationBucket {
    const sorted = [...row.durations].sort((a, b) => a - b);
    return {
      bucketStart: row._id.toISOString(),
      count: row.count,
      avgMs: Math.round(row.avg),
      p50Ms: this.percentile(sorted, 0.5),
      p99Ms: this.percentile(sorted, 0.99),
    };
  }

  private percentile(sorted: number[], q: number): number {
    if (!sorted.length) {
      return 0;
    }
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return sorted[idx];
  }

  private buildTimeline(
    config: AutoUpdateWindowConfig,
    bucketMap: Map<number, AutoUpdateRunBucket>,
    durationBuckets: AutoUpdateDurationBucket[],
    limitByBucket: Map<number, number>,
  ): AutoUpdateTimelineBucket[] {
    const durationMap = new Map(
      durationBuckets.map((bucket) => [
        this.bucketKey(new Date(bucket.bucketStart), config.bucketMs),
        bucket,
      ]),
    );
    const allBucketKeys = new Set<number>([
      ...bucketMap.keys(),
      ...durationMap.keys(),
      ...limitByBucket.keys(),
    ]);
    return [...allBucketKeys]
      .sort((a, b) => a - b)
      .map((key) =>
        this.toTimelineBucket(key, bucketMap, durationMap, limitByBucket),
      );
  }

  private toTimelineBucket(
    key: number,
    bucketMap: Map<number, AutoUpdateRunBucket>,
    durationMap: Map<number, AutoUpdateDurationBucket>,
    limitByBucket: Map<number, number>,
  ): AutoUpdateTimelineBucket {
    const bucket = bucketMap.get(key);
    const duration = durationMap.get(key);
    return {
      bucketStart: new Date(key).toISOString(),
      triggered: bucket?.triggered ?? 0,
      skipped: bucket?.skipped ?? 0,
      failed: bucket?.failed ?? 0,
      sweepCount: bucket?.sweepCount ?? 0,
      completedJobs: duration?.count ?? 0,
      avgDurationMs: duration?.avgMs ?? null,
      p50Ms: duration?.p50Ms ?? null,
      p99Ms: duration?.p99Ms ?? null,
      rateLimit567: limitByBucket.get(key) ?? 0,
    };
  }

  private async loadCurrentSnapshot(): Promise<AutoUpdateCurrentSnapshot> {
    const [
      queued,
      processing,
      perBotInflight,
      autoUpdateUsers,
      activeCabinetBots,
    ] = await Promise.all([
      this.jobModel.countDocuments({
        jobType: 'update_score',
        status: 'queued',
      }),
      this.jobModel.countDocuments({
        jobType: 'update_score',
        status: 'processing',
      }),
      this.jobModel.aggregate<{ _id: string; count: number }>([
        {
          $match: {
            status: { $in: ['queued', 'processing'] },
            botUserFriendCode: { $ne: null },
          },
        },
        { $group: { _id: '$botUserFriendCode', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      this.userModel.countDocuments({ autoUpdate: true }),
      this.botStatusModel.countDocuments({
        available: true,
        cabinetUserId: { $ne: null },
      }),
    ]);
    return {
      autoUpdateUsers,
      queued,
      processing,
      perBotInflight: perBotInflight.map((b) => ({
        friendCode: b._id,
        count: b.count,
      })),
      activeCabinetBots,
    };
  }

  private buildCapacity(
    timeline: AutoUpdateTimelineBucket[],
    snapshot: AutoUpdateCurrentSnapshot,
  ) {
    const reqsPerJob = 24;
    const reqsPerMinPerBot = 24;
    const jobsPerMin =
      (snapshot.activeCabinetBots * reqsPerMinPerBot) / Math.max(reqsPerJob, 1);
    const jobsPerSweep = jobsPerMin * 5;
    const totalTriggered = timeline.reduce((s, b) => s + b.triggered, 0);
    const totalSweepCount = timeline.reduce((s, b) => s + b.sweepCount, 0);
    const triggerRatePerSweep =
      snapshot.autoUpdateUsers > 0 && totalSweepCount > 0
        ? totalTriggered / (totalSweepCount * snapshot.autoUpdateUsers)
        : 0;
    const peakFactor = this.calculatePeakFactor(timeline);
    const maxUsersPeak =
      triggerRatePerSweep > 0 && peakFactor > 0
        ? Math.floor((jobsPerSweep * 0.7) / (triggerRatePerSweep * peakFactor))
        : null;
    return {
      activeCabinetBots: snapshot.activeCabinetBots,
      reqsPerMinPerBot,
      estimatedReqsPerJob: reqsPerJob,
      estimatedJobsPerMin: Math.round(jobsPerMin * 10) / 10,
      estimatedJobsPerSweep: Math.round(jobsPerSweep * 10) / 10,
      triggerRatePerUserPerSweep:
        Math.round(triggerRatePerSweep * 10000) / 10000,
      peakFactor: Math.round(peakFactor * 10) / 10,
      maxUsersAvg:
        triggerRatePerSweep > 0
          ? Math.floor(jobsPerSweep / triggerRatePerSweep)
          : null,
      maxUsersPeak,
      currentUtilization:
        maxUsersPeak && maxUsersPeak > 0
          ? Math.round((snapshot.autoUpdateUsers / maxUsersPeak) * 100)
          : null,
    };
  }

  private calculatePeakFactor(timeline: AutoUpdateTimelineBucket[]): number {
    const triggeredPerBucket = timeline.map((b) => b.triggered);
    const meanTriggered =
      triggeredPerBucket.length > 0
        ? triggeredPerBucket.reduce((s, x) => s + x, 0) /
          triggeredPerBucket.length
        : 0;
    const maxTriggered = Math.max(0, ...triggeredPerBucket);
    return meanTriggered > 0 ? maxTriggered / meanTriggered : 1;
  }

  private async countRateLimitLogsByBucket(
    since: Date,
    bucketMs: number,
  ): Promise<Map<number, number>> {
    const rows = await this.clickhouse.query<{ bucket: number; count: number }>(
      `
      SELECT
        toUnixTimestamp(toStartOfInterval(ts, INTERVAL {bucketSeconds:UInt32} SECOND)) * 1000 AS bucket,
        count() AS count
      FROM external_api_calls
      WHERE environment = {environment:String}
        AND ts >= parseDateTime64BestEffort({since:String}, 3, 'Asia/Shanghai')
        AND target = 'maimai_dxnet'
        AND (statusCode = 567 OR errorClass = 'rate_limit_567')
      GROUP BY bucket
      ORDER BY bucket ASC
      `,
      {
        environment: this.environment,
        since: since.toISOString(),
        bucketSeconds: Math.max(1, Math.floor(bucketMs / 1000)),
      },
    );
    const buckets = new Map<number, number>();
    for (const row of rows) {
      buckets.set(Number(row.bucket), Number(row.count));
    }

    return buckets;
  }
}
