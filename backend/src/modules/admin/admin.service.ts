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

  async getJobTrend(): Promise<JobTrend> {
    const now = new Date();
    const hours24Ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 生成过去 24 小时的每个小时时间点
    const hourPoints: Date[] = [];
    for (let i = 23; i >= 0; i--) {
      const hour = new Date(now);
      hour.setMinutes(0, 0, 0);
      hour.setHours(hour.getHours() - i);
      hourPoints.push(hour);
    }

    const buildTrendForType = async (
      skipUpdateScore: boolean,
    ): Promise<JobTrendPoint[]> => {
      // 使用 MongoDB 聚合按小时分组
      const pipeline = [
        {
          $match: {
            skipUpdateScore,
            createdAt: { $gte: hours24Ago },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
              day: { $dayOfMonth: '$createdAt' },
              hour: { $hour: '$createdAt' },
            },
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
          $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 },
        },
      ];

      const results = await this.jobModel.aggregate<{
        _id: { year: number; month: number; day: number; hour: number };
        totalCount: number;
        completedCount: number;
        failedCount: number;
        avgDuration: number | null;
      }>(pipeline as never);

      // 将结果映射到每个小时点
      const resultMap = new Map<string, (typeof results)[0]>();
      for (const r of results) {
        const key = `${r._id.year}-${r._id.month}-${r._id.day}-${r._id.hour}`;
        resultMap.set(key, r);
      }

      return hourPoints.map((hour) => {
        const key = `${hour.getFullYear()}-${hour.getMonth() + 1}-${hour.getDate()}-${hour.getHours()}`;
        const data = resultMap.get(key);

        return {
          hour: hour.toISOString(),
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
}
