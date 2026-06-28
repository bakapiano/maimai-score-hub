import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage } from 'mongoose';

import { JobEntity } from '../../job/schemas/job.schema';
import {
  JOB_STATS_CACHE_TTL_MS,
  JOB_STATS_MAX_TIME_MS,
  JOB_STATS_RANGES,
  type JobErrorStats,
  type JobErrorStatsItem,
  type JobStats,
  type JobStatsAggregateRow,
  type JobStatsRangeKey,
  type JobStatsTimeRange,
  type JobTrend,
  type JobTrendPoint,
} from './admin.types';

@Injectable()
export class AdminJobMetricsService {
  private jobStatsCache: { value: JobStats; expiresAt: number } | null = null;
  private jobStatsInFlight: Promise<JobStats> | null = null;

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
  ) {}

  async getJobStats(): Promise<JobStats> {
    const now = Date.now();
    if (this.jobStatsCache && this.jobStatsCache.expiresAt > now) {
      return this.jobStatsCache.value;
    }
    if (this.jobStatsInFlight) {
      return this.jobStatsInFlight;
    }

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
    const [nonScoreRow, scoreRow] = await Promise.all([
      this.aggregateJobStats('non-score', false, now),
      this.aggregateJobStats('score', true, now),
    ]);

    return {
      nonScoreUpdate: JOB_STATS_RANGES.map((range) =>
        this.toJobStatsTimeRange(nonScoreRow, range.key, range.label),
      ),
      scoreUpdate: JOB_STATS_RANGES.map((range) => ({
        ...this.toJobStatsTimeRange(scoreRow, range.key, range.label),
        avgDuration: this.roundNullable(scoreRow[`${range.key}AvgDuration`]),
        minDuration:
          this.numberValue(scoreRow[`${range.key}DurationCount`]) > 0
            ? this.roundNullable(scoreRow[`${range.key}MinDuration`])
            : null,
        maxDuration:
          this.numberValue(scoreRow[`${range.key}DurationCount`]) > 0
            ? this.roundNullable(scoreRow[`${range.key}MaxDuration`])
            : null,
      })),
    };
  }

  private async aggregateJobStats(
    kind: 'score' | 'non-score',
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
          jobType: kind === 'score' ? 'update_score' : { $ne: 'update_score' },
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
    const granularityHours = this.getTrendGranularityHours(hours);
    const timePoints = this.buildTrendTimePoints(
      startTime,
      now,
      granularityHours,
    );

    const [nonScoreUpdate, scoreUpdate] = await Promise.all([
      this.buildTrendForType(
        'non-score',
        startTime,
        timePoints,
        granularityHours,
      ),
      this.buildTrendForType('score', startTime, timePoints, granularityHours),
    ]);

    return {
      nonScoreUpdate,
      scoreUpdate,
    };
  }

  private getTrendGranularityHours(hours: number): number {
    if (hours <= 48) {
      return 1;
    }
    if (hours <= 168) {
      return 6;
    }
    return 24;
  }

  private buildTrendTimePoints(
    startTime: Date,
    now: Date,
    granularityHours: number,
  ): Date[] {
    const granularityMs = granularityHours * 60 * 60 * 1000;

    const timePoints: Date[] = [];
    const firstPoint = new Date(
      Math.floor(startTime.getTime() / granularityMs) * granularityMs,
    );
    for (let t = firstPoint.getTime(); t <= now.getTime(); t += granularityMs) {
      timePoints.push(new Date(t));
    }
    return timePoints;
  }

  private buildTrendGroupId(granularityHours: number) {
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
    return {
      year: { $year: '$createdAt' },
      month: { $month: '$createdAt' },
      day: { $dayOfMonth: '$createdAt' },
      bucket: { $literal: 0 },
    };
  }

  private async buildTrendForType(
    kind: 'score' | 'non-score',
    startTime: Date,
    timePoints: Date[],
    granularityHours: number,
  ): Promise<JobTrendPoint[]> {
    const results = await this.jobModel.aggregate<{
      _id: { year: number; month: number; day: number; bucket: number };
      totalCount: number;
      completedCount: number;
      failedCount: number;
      avgDuration: number | null;
    }>([
      {
        $match: {
          jobType: kind === 'score' ? 'update_score' : { $ne: 'update_score' },
          createdAt: { $gte: startTime },
        },
      },
      {
        $group: {
          _id: this.buildTrendGroupId(granularityHours),
          totalCount: { $sum: 1 },
          completedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
          },
          failedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
          avgDuration: this.avgCompletedDurationExpression(),
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
    ] as never);
    return this.toTrendPoints(results, timePoints, granularityHours);
  }

  private avgCompletedDurationExpression() {
    return {
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
    };
  }

  private toTrendPoints(
    results: Array<{
      _id: { year: number; month: number; day: number; bucket: number };
      totalCount: number;
      completedCount: number;
      failedCount: number;
      avgDuration: number | null;
    }>,
    timePoints: Date[],
    granularityHours: number,
  ): JobTrendPoint[] {
    const resultMap = new Map<string, (typeof results)[0]>();
    for (const r of results) {
      const key = `${r._id.year}-${r._id.month}-${r._id.day}-${r._id.bucket}`;
      resultMap.set(key, r);
    }
    return timePoints.map((tp) =>
      this.toTrendPoint(tp, resultMap, granularityHours),
    );
  }

  private toTrendPoint(
    tp: Date,
    resultMap: Map<
      string,
      {
        totalCount: number;
        completedCount: number;
        failedCount: number;
        avgDuration: number | null;
      }
    >,
    granularityHours: number,
  ): JobTrendPoint {
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
}
