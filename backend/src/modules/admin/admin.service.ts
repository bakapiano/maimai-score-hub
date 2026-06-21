import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage } from 'mongoose';
import { UserEntity } from '../users/user.schema';
import { MusicEntity } from '../music/music.schema';
import { SyncEntity } from '../sync/sync.schema';
import { JobEntity } from '../job/job.schema';
import { BotStatusEntity } from './bot-status.schema';
import { WorkerLogEntity } from '../worker-logs/worker-log.schema';
import { AutoUpdateRunEntity } from '../auto-update/auto-update-run.schema';
import { CoverService } from '../cover/cover.service';
import { MusicService } from '../music/music.service';

export interface AdminStats {
  userCount: number;
  musicCount: number;
  syncCount: number;
  coverCount: number;
}

export interface JobStatsTimeRange {
  label: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
}

export interface JobStatsWithDuration extends JobStatsTimeRange {
  avgDuration: number | null;
  minDuration: number | null;
  maxDuration: number | null;
}

export interface JobStats {
  skipUpdateScore: JobStatsTimeRange[];
  withUpdateScore: JobStatsWithDuration[];
}

type JobStatsRangeKey = 'oneHour' | 'oneDay' | 'sevenDays';

const JOB_STATS_CACHE_TTL_MS = 60 * 1000;
const JOB_STATS_MAX_TIME_MS = 3000;
const JOB_STATS_RANGES: Array<{
  key: JobStatsRangeKey;
  label: string;
  ms: number;
}> = [
  { key: 'oneHour', label: '1小时', ms: 60 * 60 * 1000 },
  { key: 'oneDay', label: '24小时', ms: 24 * 60 * 60 * 1000 },
  { key: 'sevenDays', label: '7天', ms: 7 * 24 * 60 * 60 * 1000 },
];

type JobStatsAggregateRow = Record<string, number | null>;

export interface JobTrendPoint {
  hour: string; // ISO string for the hour start
  totalCount: number;
  completedCount: number;
  failedCount: number;
  avgDuration: number | null;
}

export interface JobTrend {
  skipUpdateScore: JobTrendPoint[];
  withUpdateScore: JobTrendPoint[];
}

export interface JobErrorStatsItem {
  error: string;
  count: number;
}

export interface JobErrorStats {
  label: string;
  items: JobErrorStatsItem[];
}

export interface ActiveJob {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  executing: boolean;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  createdAt: string;
  updatedAt: string;
  runningDuration: number; // milliseconds since createdAt
}

export interface ActiveJobsStats {
  queuedCount: number;
  processingCount: number;
  jobs: ActiveJob[];
}

export interface SearchJobResult {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  error: string | null;
  executing: boolean;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  updateScoreDuration: number | null;
  createdAt: string;
  updatedAt: string;
  raw: Record<string, unknown>;
}

@Injectable()
export class AdminService {
  private jobStatsCache: { value: JobStats; expiresAt: number } | null = null;
  private jobStatsInFlight: Promise<JobStats> | null = null;

  constructor(
    @InjectModel(UserEntity.name)
    private readonly userModel: Model<UserEntity>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicEntity>,
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncEntity>,
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @InjectModel(BotStatusEntity.name)
    private readonly botStatusModel: Model<BotStatusEntity>,
    @InjectModel(WorkerLogEntity.name)
    private readonly workerLogModel: Model<WorkerLogEntity>,
    @InjectModel(AutoUpdateRunEntity.name)
    private readonly autoUpdateRunModel: Model<AutoUpdateRunEntity>,
    private readonly coverService: CoverService,
    private readonly musicService: MusicService,
  ) {}

  async getStats(): Promise<AdminStats> {
    const [userCount, musicCount, syncCount, coverCount] = await Promise.all([
      this.userModel.estimatedDocumentCount(),
      this.musicModel.estimatedDocumentCount(),
      this.syncModel.estimatedDocumentCount(),
      this.coverService.getCoverCount(),
    ]);

    return {
      userCount,
      musicCount,
      syncCount,
      coverCount,
    };
  }

  async getAllUsers() {
    const users = await this.userModel
      .find()
      .select({
        _id: 1,
        friendCode: 1,
        profile: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .sort({ createdAt: -1 })
      .lean();

    return users.map((u) => ({
      id: u._id.toString(),
      friendCode: u.friendCode,
      username: u.profile?.username ?? null,
      rating: u.profile?.rating ?? null,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));
  }

  async syncCovers() {
    return this.coverService.syncAll();
  }

  async forceSyncCovers() {
    return this.coverService.forceSyncAll();
  }

  async backfillCoverVariants() {
    return this.coverService.backfillLocalVariants();
  }

  async syncMusic() {
    return this.musicService.syncMusicData();
  }

  async getActiveJobs(): Promise<ActiveJobsStats> {
    const now = Date.now();

    const [queuedCount, processingCount, jobs] = await Promise.all([
      this.jobModel.countDocuments({ status: 'queued' }),
      this.jobModel.countDocuments({ status: 'processing' }),
      this.jobModel
        .find({ status: { $in: ['queued', 'processing'] } })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);

    return {
      queuedCount,
      processingCount,
      jobs: jobs.map((job) => ({
        id: job.id,
        friendCode: job.friendCode,
        skipUpdateScore: job.skipUpdateScore,
        botUserFriendCode: job.botUserFriendCode ?? null,
        status: job.status,
        stage: job.stage,
        executing: job.executing,
        scoreProgress: job.scoreProgress,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        runningDuration: now - job.createdAt.getTime(),
      })),
    };
  }

  async getJobStats(): Promise<JobStats> {
    const now = Date.now();
    if (this.jobStatsCache && this.jobStatsCache.expiresAt > now) {
      return this.jobStatsCache.value;
    }
    if (this.jobStatsInFlight) return this.jobStatsInFlight;

    this.jobStatsInFlight = this.computeJobStats(now)
      .then((value) => {
        this.jobStatsCache = {
          value,
          expiresAt: Date.now() + JOB_STATS_CACHE_TTL_MS,
        };
        return value;
      })
      .finally(() => {
        this.jobStatsInFlight = null;
      });

    return this.jobStatsInFlight;
  }

  private async computeJobStats(now: number): Promise<JobStats> {
    const [skipRow, withRow] = await Promise.all([
      this.aggregateJobStats(true, false, now),
      this.aggregateJobStats(false, true, now),
    ]);

    return {
      skipUpdateScore: JOB_STATS_RANGES.map((range) =>
        this.toJobStatsTimeRange(skipRow, range.key, range.label),
      ),
      withUpdateScore: JOB_STATS_RANGES.map((range) => ({
        ...this.toJobStatsTimeRange(withRow, range.key, range.label),
        avgDuration: this.roundNullable(withRow[`${range.key}AvgDuration`]),
        minDuration:
          this.numberValue(withRow[`${range.key}DurationCount`]) > 0
            ? this.roundNullable(withRow[`${range.key}MinDuration`])
            : null,
        maxDuration:
          this.numberValue(withRow[`${range.key}DurationCount`]) > 0
            ? this.roundNullable(withRow[`${range.key}MaxDuration`])
            : null,
      })),
    };
  }

  private async aggregateJobStats(
    skipUpdateScore: boolean,
    includeDuration: boolean,
    now: number,
  ): Promise<JobStatsAggregateRow> {
    const sevenDaysAgo = new Date(now - JOB_STATS_RANGES[2].ms);
    const group = { _id: null } as PipelineStage.Group['$group'] &
      Record<string, unknown>;

    for (const range of JOB_STATS_RANGES) {
      const start = new Date(now - range.ms);
      const inRange = { $gte: ['$createdAt', start] };
      const completedInRange = {
        $and: [inRange, { $eq: ['$status', 'completed'] }],
      };
      const failedInRange = {
        $and: [inRange, { $eq: ['$status', 'failed'] }],
      };

      group[`${range.key}Total`] = {
        $sum: { $cond: [inRange, 1, 0] },
      };
      group[`${range.key}Completed`] = {
        $sum: { $cond: [completedInRange, 1, 0] },
      };
      group[`${range.key}Failed`] = {
        $sum: { $cond: [failedInRange, 1, 0] },
      };

      if (includeDuration) {
        const durationInRange = {
          $and: [
            completedInRange,
            { $ne: ['$updateScoreDuration', null] },
            { $gt: ['$updateScoreDuration', 0] },
          ],
        };
        group[`${range.key}DurationCount`] = {
          $sum: { $cond: [durationInRange, 1, 0] },
        };
        group[`${range.key}AvgDuration`] = {
          $avg: { $cond: [durationInRange, '$updateScoreDuration', null] },
        };
        group[`${range.key}MinDuration`] = {
          $min: {
            $cond: [
              durationInRange,
              '$updateScoreDuration',
              Number.MAX_SAFE_INTEGER,
            ],
          },
        };
        group[`${range.key}MaxDuration`] = {
          $max: { $cond: [durationInRange, '$updateScoreDuration', -1] },
        };
      }
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          skipUpdateScore,
          status: { $in: ['completed', 'failed'] },
          createdAt: { $gte: sevenDaysAgo },
        },
      },
      { $group: group },
    ];
    const [row] = await this.jobModel
      .aggregate<JobStatsAggregateRow>(pipeline)
      .option({ maxTimeMS: JOB_STATS_MAX_TIME_MS })
      .exec();
    return row ?? {};
  }

  private toJobStatsTimeRange(
    row: JobStatsAggregateRow,
    key: JobStatsRangeKey,
    label: string,
  ): JobStatsTimeRange {
    const totalCount = this.numberValue(row[`${key}Total`]);
    const completedCount = this.numberValue(row[`${key}Completed`]);
    return {
      label,
      totalCount,
      completedCount,
      failedCount: this.numberValue(row[`${key}Failed`]),
      successRate:
        totalCount > 0
          ? Math.round((completedCount / totalCount) * 10000) / 100
          : 0,
    };
  }

  private numberValue(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private roundNullable(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value)
      : null;
  }

  async getJobTrend(hours = 24): Promise<JobTrend> {
    const now = new Date();
    const startTime = new Date(now.getTime() - hours * 60 * 60 * 1000);

    // 根据时间范围决定粒度
    // <=48h → 每小时, <=168h(7天) → 每6小时, >168h → 每天
    let granularityHours: number;
    if (hours <= 48) {
      granularityHours = 1;
    } else if (hours <= 168) {
      granularityHours = 6;
    } else {
      granularityHours = 24;
    }
    const granularityMs = granularityHours * 60 * 60 * 1000;

    // 生成时间点
    const timePoints: Date[] = [];
    const firstPoint = new Date(
      Math.floor(startTime.getTime() / granularityMs) * granularityMs,
    );
    for (let t = firstPoint.getTime(); t <= now.getTime(); t += granularityMs) {
      timePoints.push(new Date(t));
    }

    // 构建 MongoDB $group 的 _id 字段
    const buildGroupId = () => {
      if (granularityHours < 24) {
        return {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
          bucket: {
            $multiply: [
              {
                $floor: {
                  $divide: [{ $hour: '$createdAt' }, granularityHours],
                },
              },
              granularityHours,
            ],
          },
        };
      }
      // 按天分组
      return {
        year: { $year: '$createdAt' },
        month: { $month: '$createdAt' },
        day: { $dayOfMonth: '$createdAt' },
        bucket: { $literal: 0 },
      };
    };

    const buildTrendForType = async (
      skipUpdateScore: boolean,
    ): Promise<JobTrendPoint[]> => {
      const pipeline = [
        {
          $match: {
            skipUpdateScore,
            createdAt: { $gte: startTime },
          },
        },
        {
          $group: {
            _id: buildGroupId(),
            totalCount: { $sum: 1 },
            completedCount: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
            },
            failedCount: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
            },
            avgDuration: {
              $avg: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', 'completed'] },
                      { $ne: ['$updateScoreDuration', null] },
                      { $gt: ['$updateScoreDuration', 0] },
                    ],
                  },
                  '$updateScoreDuration',
                  null,
                ],
              },
            },
          },
        },
        {
          $sort: {
            '_id.year': 1,
            '_id.month': 1,
            '_id.day': 1,
            '_id.bucket': 1,
          },
        },
      ];

      const results = await this.jobModel.aggregate<{
        _id: { year: number; month: number; day: number; bucket: number };
        totalCount: number;
        completedCount: number;
        failedCount: number;
        avgDuration: number | null;
      }>(pipeline as never);

      // 将结果映射到时间点
      const resultMap = new Map<string, (typeof results)[0]>();
      for (const r of results) {
        const key = `${r._id.year}-${r._id.month}-${r._id.day}-${r._id.bucket}`;
        resultMap.set(key, r);
      }

      return timePoints.map((tp) => {
        const bucket =
          granularityHours < 24
            ? Math.floor(tp.getUTCHours() / granularityHours) * granularityHours
            : 0;
        const key = `${tp.getUTCFullYear()}-${tp.getUTCMonth() + 1}-${tp.getUTCDate()}-${bucket}`;
        const data = resultMap.get(key);

        return {
          hour: tp.toISOString(),
          totalCount: data?.totalCount ?? 0,
          completedCount: data?.completedCount ?? 0,
          failedCount: data?.failedCount ?? 0,
          avgDuration: data?.avgDuration ? Math.round(data.avgDuration) : null,
        };
      });
    };

    const [skipUpdateScore, withUpdateScore] = await Promise.all([
      buildTrendForType(true),
      buildTrendForType(false),
    ]);

    return {
      skipUpdateScore,
      withUpdateScore,
    };
  }

  async getJobErrorStats(): Promise<JobErrorStats[]> {
    const now = new Date();
    const timeRanges = [
      { label: '1小时', ms: 60 * 60 * 1000 },
      { label: '24小时', ms: 24 * 60 * 60 * 1000 },
      { label: '7天', ms: 7 * 24 * 60 * 60 * 1000 },
      { label: '30天', ms: 30 * 24 * 60 * 60 * 1000 },
      { label: '全部', ms: Infinity },
    ];

    const buildErrorStatsForRange = async (
      startTime: Date | null,
    ): Promise<JobErrorStatsItem[]> => {
      const matchFilter: Record<string, unknown> = {
        status: 'failed',
        error: { $ne: null, $exists: true },
      };
      if (startTime) {
        matchFilter.createdAt = { $gte: startTime };
      }

      const results = await this.jobModel.aggregate<{
        _id: string;
        count: number;
      }>([
        { $match: matchFilter },
        {
          $group: {
            _id: '$error',
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 50 },
      ]);

      return results.map((r) => ({
        error: r._id || '未知错误',
        count: r.count,
      }));
    };

    const errorStats: JobErrorStats[] = [];
    for (const range of timeRanges) {
      const startTime =
        range.ms === Infinity ? null : new Date(now.getTime() - range.ms);
      const items = await buildErrorStatsForRange(startTime);
      errorStats.push({ label: range.label, items });
    }

    return errorStats;
  }

  async searchJobs(params: {
    friendCode?: string;
    status?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    data: SearchJobResult[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const filter: Record<string, unknown> = {};

    if (params.friendCode) {
      filter.friendCode = params.friendCode;
    }

    const validStatuses = [
      'queued',
      'processing',
      'completed',
      'failed',
      'canceled',
    ];
    if (params.status && validStatuses.includes(params.status)) {
      filter.status = params.status;
    }

    const skip = (params.page - 1) * params.pageSize;

    const [jobs, total] = await Promise.all([
      this.jobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(params.pageSize)
        .lean(),
      this.jobModel.countDocuments(filter),
    ]);

    return {
      data: jobs.map((job) => {
        const { _id, __v, ...raw } = job as unknown as Record<string, unknown>;
        return {
          id: job.id,
          friendCode: job.friendCode,
          skipUpdateScore: job.skipUpdateScore,
          botUserFriendCode: job.botUserFriendCode ?? null,
          status: job.status,
          stage: job.stage,
          error: job.error ?? null,
          executing: job.executing,
          scoreProgress: job.scoreProgress ?? null,
          updateScoreDuration: job.updateScoreDuration ?? null,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          raw,
        };
      }),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /**
   * Aggregated dashboard for the auto-update subsystem. Returns:
   *   - timeline buckets: triggered / skippedHashUnchanged / skippedThrottled
   *     / failed counts per bucket (5min for 24h window, 1h for 7d window)
   *   - duration trend per bucket: avg, p50, p99 of updateScoreDuration
   *   - 567 rate-limit hits per bucket (parsed from worker_logs)
   *   - "now" snapshot: queued + processing counts, per-bot inflight,
   *     active auto-update user count
   *   - capacity estimate: throughput vs current load
   *   - cabinet-optimization hit rate: % of recent update_score jobs
   *     that received a cabinetScoreMap; avg friend-VS request count saved
   */
  async getAutoUpdateMetrics(window: '24h' | '7d') {
    const now = Date.now();
    const windowMs =
      window === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const bucketMinutes = window === '24h' ? 5 : 60;
    const bucketMs = bucketMinutes * 60 * 1000;
    const since = new Date(now - windowMs);

    // ---- (1) timeline: aggregate per-bucket sweep stats from
    // auto_update_runs (one doc per cron tick, source of truth for
    // triggered/skippedNoChange/failed) instead of grepping logs.
    const runDocs = await this.autoUpdateRunModel
      .find({
        triggeredAt: { $gte: since },
      })
      .select({
        triggeredAt: 1,
        triggered: 1,
        skippedNoChange: 1,
        failed: 1,
        totalUsers: 1,
      })
      .lean()
      .exec();
    type Bucket = {
      bucketStart: string;
      triggered: number;
      skipped: number;
      failed: number;
      sweepCount: number;
    };
    const bucketMap = new Map<number, Bucket>();
    const bucketKey = (d: Date | number) =>
      Math.floor((d instanceof Date ? d.getTime() : d) / bucketMs) * bucketMs;
    const ensureBucket = (k: number): Bucket => {
      let b = bucketMap.get(k);
      if (!b) {
        b = {
          bucketStart: new Date(k).toISOString(),
          triggered: 0,
          skipped: 0,
          failed: 0,
          sweepCount: 0,
        };
        bucketMap.set(k, b);
      }
      return b;
    };
    for (const r of runDocs) {
      if (!r.triggeredAt) continue;
      const b = ensureBucket(bucketKey(r.triggeredAt));
      b.triggered += r.triggered ?? 0;
      b.skipped += r.skippedNoChange ?? 0;
      b.failed += r.failed ?? 0;
      b.sweepCount += 1;
    }

    // ---- (2) duration trend per bucket ----
    const durationsByBucket = await this.jobModel
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
            createdAt: { $gte: since },
          },
        },
        {
          $group: {
            _id: {
              $dateTrunc: {
                date: '$createdAt',
                unit: 'minute',
                binSize: bucketMinutes,
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
    const percentile = (sorted: number[], q: number): number => {
      if (!sorted.length) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
      return sorted[idx];
    };
    const durationBuckets = durationsByBucket.map((d) => {
      const sorted = [...d.durations].sort((a, b) => a - b);
      return {
        bucketStart: d._id.toISOString(),
        count: d.count,
        avgMs: Math.round(d.avg),
        p50Ms: percentile(sorted, 0.5),
        p99Ms: percentile(sorted, 0.99),
      };
    });

    // ---- (3) 567 rate-limit hits per bucket ----
    const limitLogs = await this.workerLogModel
      .find({ ts: { $gte: since }, message: /\(567\)/ })
      .select({ ts: 1 })
      .lean()
      .exec();
    const limitByBucket = new Map<number, number>();
    for (const l of limitLogs) {
      const k = bucketKey(l.ts);
      limitByBucket.set(k, (limitByBucket.get(k) ?? 0) + 1);
    }

    // ---- (4) merged timeline ----
    const allBucketKeys = new Set<number>([
      ...bucketMap.keys(),
      ...durationBuckets.map((d) => bucketKey(new Date(d.bucketStart))),
      ...limitByBucket.keys(),
    ]);
    const timeline = [...allBucketKeys]
      .sort((a, b) => a - b)
      .map((k) => {
        const b = bucketMap.get(k);
        const dur = durationBuckets.find(
          (d) => bucketKey(new Date(d.bucketStart)) === k,
        );
        return {
          bucketStart: new Date(k).toISOString(),
          triggered: b?.triggered ?? 0,
          skipped: b?.skipped ?? 0,
          failed: b?.failed ?? 0,
          sweepCount: b?.sweepCount ?? 0,
          completedJobs: dur?.count ?? 0,
          avgDurationMs: dur?.avgMs ?? null,
          p50Ms: dur?.p50Ms ?? null,
          p99Ms: dur?.p99Ms ?? null,
          rateLimit567: limitByBucket.get(k) ?? 0,
        };
      });

    // ---- (5) "now" snapshot ----
    const [queuedCount, processingCount, perBotInflight, autoUpdateUsers] =
      await Promise.all([
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
      ]);

    // ---- (6) cabinet optimization hit rate (last 200 update_score jobs) ----
    const recentIdle = await this.jobModel
      .find({ jobType: 'update_score' })
      .sort({ createdAt: -1 })
      .limit(200)
      .select({ cabinetScoreMap: 1, diffsToScrape: 1, createdAt: 1 })
      .lean()
      .exec();
    let withCabinet = 0;
    let withDiffsToScrape = 0;
    let totalDiffsScraped = 0;
    let diffsToScrapeCount = 0;
    for (const j of recentIdle) {
      const csm = (j as { cabinetScoreMap?: unknown }).cabinetScoreMap;
      const dts = (j as { diffsToScrape?: number[] | null }).diffsToScrape;
      if (csm && Object.keys(csm as Record<string, unknown>).length > 0) {
        withCabinet++;
      }
      if (Array.isArray(dts) && dts.length > 0) {
        withDiffsToScrape++;
        totalDiffsScraped += dts.length;
        diffsToScrapeCount++;
      }
    }
    const cabinetHitRate = recentIdle.length
      ? Math.round((withCabinet / recentIdle.length) * 1000) / 10
      : 0;
    const diffSkipHitRate = recentIdle.length
      ? Math.round((withDiffsToScrape / recentIdle.length) * 1000) / 10
      : 0;
    const avgDiffsScraped = diffsToScrapeCount
      ? Math.round((totalDiffsScraped / diffsToScrapeCount) * 10) / 10
      : null;

    // ---- (7) capacity estimate ----
    // Active cabinet-bound bots (the only ones that take auto-update jobs).
    const activeCabinetBots = await this.botStatusModel.countDocuments({
      available: true,
      cabinetUserId: { $ne: null },
    });
    // Per-bot throughput rough estimate: 60s/2.5s spacing = 24 req/min;
    // a typical update_score job under cabinet path needs ~16 req
    // (8 diffs × 2 sides for scoreType=2 only). Without cabinet (rare
    // now): ~32 req. Assume cabinet hit rate from recent.
    const reqsPerJob =
      16 * (1 - cabinetHitRate / 100) + 8 * (cabinetHitRate / 100);
    const reqsPerMinPerBot = 24;
    const jobsPerMin =
      (activeCabinetBots * reqsPerMinPerBot) / Math.max(reqsPerJob, 1);
    const jobsPerSweep = jobsPerMin * 5;
    // sweep触发率 = recent triggered / sweepCount → per-user trigger probability ≈
    // (total triggered in window) / (total sweeps in window × N users)
    const totalTriggered = timeline.reduce((s, b) => s + b.triggered, 0);
    const totalSkipped = timeline.reduce((s, b) => s + b.skipped, 0);
    const totalSweepCount = timeline.reduce((s, b) => s + b.sweepCount, 0);
    const triggerRatePerSweep =
      autoUpdateUsers > 0 && totalSweepCount > 0
        ? totalTriggered / (totalSweepCount * autoUpdateUsers)
        : 0;
    // Peak factor: max bucket triggered / mean bucket triggered
    const triggeredPerBucket = timeline.map((b) => b.triggered);
    const meanTriggered =
      triggeredPerBucket.length > 0
        ? triggeredPerBucket.reduce((s, x) => s + x, 0) /
          triggeredPerBucket.length
        : 0;
    const maxTriggered = Math.max(0, ...triggeredPerBucket);
    const peakFactor = meanTriggered > 0 ? maxTriggered / meanTriggered : 1;
    // Sustainable user upper bound: at peak, expected triggered per sweep
    // shouldn't exceed jobsPerSweep / safetyFactor.
    const safetyFactor = 0.7;
    const maxUsersAvg =
      triggerRatePerSweep > 0
        ? Math.floor(jobsPerSweep / triggerRatePerSweep)
        : null;
    const maxUsersPeak =
      triggerRatePerSweep > 0 && peakFactor > 0
        ? Math.floor(
            (jobsPerSweep * safetyFactor) / (triggerRatePerSweep * peakFactor),
          )
        : null;

    return {
      window,
      bucketMinutes,
      generatedAt: new Date(now).toISOString(),
      timeline,
      now: {
        autoUpdateUsers,
        queued: queuedCount,
        processing: processingCount,
        perBotInflight: perBotInflight.map((b) => ({
          friendCode: b._id,
          count: b.count,
        })),
        activeCabinetBots,
      },
      optimization: {
        sampleSize: recentIdle.length,
        cabinetHitRate, // %
        diffSkipHitRate, // %
        avgDiffsScraped, // when diffsToScrape used, average size
        // estimated friend-VS reqs per job under current optimization
        // (16 = full no-cabinet, 8 = cabinet path, 2 per scraped diff)
        estimatedReqsPerJob: Math.round(reqsPerJob * 10) / 10,
      },
      capacity: {
        activeCabinetBots,
        reqsPerMinPerBot,
        estimatedJobsPerMin: Math.round(jobsPerMin * 10) / 10,
        estimatedJobsPerSweep: Math.round(jobsPerSweep * 10) / 10,
        triggerRatePerUserPerSweep:
          Math.round(triggerRatePerSweep * 10000) / 10000,
        peakFactor: Math.round(peakFactor * 10) / 10,
        maxUsersAvg, // upper bound under average load
        maxUsersPeak, // upper bound respecting peak factor + safety
        currentUtilization:
          maxUsersPeak && maxUsersPeak > 0
            ? Math.round((autoUpdateUsers / maxUsersPeak) * 100)
            : null, // %
      },
      summary: {
        totalTriggered,
        totalSkipped,
        totalSweepCount,
        total567: timeline.reduce((s, b) => s + b.rateLimit567, 0),
      },
    };
  }

  /**
   * Aggregated stats for prober auto-export (diving-fish + lxns) across
   * ALL job types (send_friend_request / update_score / manual) — not just auto-update.
   * Source of truth: jobs.autoExportResult populated by JobService.runAutoExport
   * after the score sync completes.
   */
  async getProberExportMetrics(window: '24h' | '7d') {
    const now = Date.now();
    const windowMs =
      window === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const bucketMinutes = window === '24h' ? 60 : 60 * 6;
    const since = new Date(now - windowMs);
    const bucketFmt = bucketMinutes >= 60 ? '%Y-%m-%d %H:00' : '%Y-%m-%d %H:%M';

    type ExportBucketRow = {
      _id: { hr: string; provider: string; status: string };
      count: number;
    };
    const exportRows = await this.jobModel
      .aggregate<ExportBucketRow>([
        {
          $match: {
            createdAt: { $gte: since },
            autoExportResult: { $ne: null },
          },
        },
        {
          $project: {
            createdAt: 1,
            entries: {
              $filter: {
                input: [
                  {
                    provider: 'divingFish',
                    status: '$autoExportResult.divingFish.status',
                  },
                  {
                    provider: 'lxns',
                    status: '$autoExportResult.lxns.status',
                  },
                ],
                as: 'e',
                cond: { $ne: ['$$e.status', null] },
              },
            },
          },
        },
        { $unwind: '$entries' },
        {
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
        },
      ])
      .exec();
    type ExportBucket = {
      label: string;
      divingFish: { success: number; failed: number };
      lxns: { success: number; failed: number };
    };
    const exportBucketMap = new Map<string, ExportBucket>();
    for (const r of exportRows) {
      let b = exportBucketMap.get(r._id.hr);
      if (!b) {
        b = {
          label: r._id.hr,
          divingFish: { success: 0, failed: 0 },
          lxns: { success: 0, failed: 0 },
        };
        exportBucketMap.set(r._id.hr, b);
      }
      const provider = r._id.provider as 'divingFish' | 'lxns';
      const status = r._id.status as 'success' | 'failed';
      if (status === 'success' || status === 'failed') {
        b[provider][status] += r.count;
      }
    }
    const timeline = [...exportBucketMap.values()].sort((a, b) =>
      a.label.localeCompare(b.label),
    );

    // Top failure messages
    const topFailures = await this.jobModel
      .aggregate<{
        _id: { provider: string; message: string };
        count: number;
        lastSeen: Date;
      }>([
        {
          $match: {
            createdAt: { $gte: since },
            autoExportResult: { $ne: null },
          },
        },
        {
          $project: {
            createdAt: 1,
            df: '$autoExportResult.divingFish',
            lxns: '$autoExportResult.lxns',
          },
        },
        {
          $project: {
            createdAt: 1,
            entries: {
              $concatArrays: [
                {
                  $cond: [
                    { $eq: ['$df.status', 'failed'] },
                    [
                      {
                        provider: 'divingFish',
                        message: { $ifNull: ['$df.message', 'unknown'] },
                      },
                    ],
                    [],
                  ],
                },
                {
                  $cond: [
                    { $eq: ['$lxns.status', 'failed'] },
                    [
                      {
                        provider: 'lxns',
                        message: { $ifNull: ['$lxns.message', 'unknown'] },
                      },
                    ],
                    [],
                  ],
                },
              ],
            },
          },
        },
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
    const failures = topFailures.map((r) => ({
      provider: r._id.provider,
      message: r._id.message,
      count: r.count,
      lastSeenAt: r.lastSeen.toISOString(),
    }));

    type ExportTotals = { success: number; failed: number; rate: number };
    const totals: { divingFish: ExportTotals; lxns: ExportTotals } = {
      divingFish: { success: 0, failed: 0, rate: 0 },
      lxns: { success: 0, failed: 0, rate: 0 },
    };
    for (const b of timeline) {
      totals.divingFish.success += b.divingFish.success;
      totals.divingFish.failed += b.divingFish.failed;
      totals.lxns.success += b.lxns.success;
      totals.lxns.failed += b.lxns.failed;
    }
    for (const k of ['divingFish', 'lxns'] as const) {
      const t = totals[k];
      const total = t.success + t.failed;
      t.rate = total > 0 ? Math.round((t.success / total) * 1000) / 10 : 0;
    }

    // Recent failures table (last 50, with friendCode + jobType for triage)
    const recent = await this.jobModel
      .find({
        createdAt: { $gte: since },
        $or: [
          { 'autoExportResult.divingFish.status': 'failed' },
          { 'autoExportResult.lxns.status': 'failed' },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .select({
        id: 1,
        friendCode: 1,
        jobType: 1,
        createdAt: 1,
        autoExportResult: 1,
        _id: 0,
      })
      .lean()
      .exec();

    return {
      window,
      bucketMinutes,
      generatedAt: new Date(now).toISOString(),
      totals,
      timeline,
      topFailures: failures,
      recentFailures: recent.map((r) => ({
        jobId: r.id,
        friendCode: r.friendCode,
        jobType: r.jobType,
        createdAt: r.createdAt.toISOString(),
        divingFish: r.autoExportResult?.divingFish ?? null,
        lxns: r.autoExportResult?.lxns ?? null,
      })),
    };
  }
}
