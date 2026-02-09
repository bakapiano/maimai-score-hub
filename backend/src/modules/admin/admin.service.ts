import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { UserEntity } from '../users/user.schema';
import { MusicEntity } from '../music/music.schema';
import { SyncEntity } from '../sync/sync.schema';
import { JobEntity } from '../job/job.schema';
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
  pickedAt: string | null;
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
  pickedAt: string | null;
}

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(UserEntity.name)
    private readonly userModel: Model<UserEntity>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicEntity>,
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncEntity>,
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly coverService: CoverService,
    private readonly musicService: MusicService,
  ) {}

  async getStats(): Promise<AdminStats> {
    const [userCount, musicCount, syncCount, coverCount] = await Promise.all([
      this.userModel.countDocuments(),
      this.musicModel.countDocuments(),
      this.syncModel.countDocuments(),
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
        pickedAt: job.pickedAt?.toISOString() ?? null,
        runningDuration: now - job.createdAt.getTime(),
      })),
    };
  }

  async getJobStats(): Promise<JobStats> {
    const now = new Date();
    const timeRanges = [
      { label: '1小时', ms: 60 * 60 * 1000 },
      { label: '24小时', ms: 24 * 60 * 60 * 1000 },
      { label: '7天', ms: 7 * 24 * 60 * 60 * 1000 },
      { label: '30天', ms: 30 * 24 * 60 * 60 * 1000 },
      { label: '全部', ms: Infinity },
    ];

    const buildStatsForRange = async (
      startTime: Date | null,
      skipUpdateScore: boolean,
    ) => {
      const filter: Record<string, unknown> = { skipUpdateScore };
      if (startTime) {
        filter.createdAt = { $gte: startTime };
      }

      const [total, completed, failed] = await Promise.all([
        this.jobModel.countDocuments(filter),
        this.jobModel.countDocuments({ ...filter, status: 'completed' }),
        this.jobModel.countDocuments({ ...filter, status: 'failed' }),
      ]);

      return {
        totalCount: total,
        completedCount: completed,
        failedCount: failed,
        successRate:
          total > 0 ? Math.round((completed / total) * 10000) / 100 : 0,
      };
    };

    const buildStatsWithDurationForRange = async (
      startTime: Date | null,
      skipUpdateScore: boolean,
    ) => {
      const baseStats = await buildStatsForRange(startTime, skipUpdateScore);

      // 获取有 updateScoreDuration 的已完成任务的统计
      const durationFilter: Record<string, unknown> = {
        skipUpdateScore,
        status: 'completed',
        updateScoreDuration: { $ne: null, $gt: 0 },
      };
      if (startTime) {
        durationFilter.createdAt = { $gte: startTime };
      }

      const durationStats = await this.jobModel.aggregate<{
        avgDuration: number;
        minDuration: number;
        maxDuration: number;
      }>([
        { $match: durationFilter },
        {
          $group: {
            _id: null,
            avgDuration: { $avg: '$updateScoreDuration' },
            minDuration: { $min: '$updateScoreDuration' },
            maxDuration: { $max: '$updateScoreDuration' },
          },
        },
      ]);

      const duration = durationStats[0] ?? null;

      return {
        ...baseStats,
        avgDuration: duration ? Math.round(duration.avgDuration) : null,
        minDuration: duration ? Math.round(duration.minDuration) : null,
        maxDuration: duration ? Math.round(duration.maxDuration) : null,
      };
    };

    const skipUpdateScoreStats: JobStatsTimeRange[] = [];
    const withUpdateScoreStats: JobStatsWithDuration[] = [];

    for (const range of timeRanges) {
      const startTime =
        range.ms === Infinity ? null : new Date(now.getTime() - range.ms);

      const [skipStats, withStats] = await Promise.all([
        buildStatsForRange(startTime, true),
        buildStatsWithDurationForRange(startTime, false),
      ]);

      skipUpdateScoreStats.push({ label: range.label, ...skipStats });
      withUpdateScoreStats.push({ label: range.label, ...withStats });
    }

    return {
      skipUpdateScore: skipUpdateScoreStats,
      withUpdateScore: withUpdateScoreStats,
    };
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
    limit: number;
  }): Promise<SearchJobResult[]> {
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

    const jobs = await this.jobModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(params.limit)
      .lean();

    return jobs.map((job) => ({
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
      pickedAt: job.pickedAt?.toISOString() ?? null,
    }));
  }
}
