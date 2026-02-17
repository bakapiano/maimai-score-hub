import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model } from 'mongoose';
import {
  JobTempCacheEntity,
  type JobTempCacheDocument,
} from './temp-cache.schema';

/**
 * Job 临时缓存服务
 * 用于在 update_score 阶段存储中间结果，支持任务恢复
 */
@Injectable()
export class JobTempCacheService {
  private readonly logger = new Logger(JobTempCacheService.name);

  constructor(
    @InjectModel(JobTempCacheEntity.name)
    private readonly cacheModel: Model<JobTempCacheDocument>,
  ) {}

  /**
   * 获取缓存的 HTML
   */
  async get(jobId: string, diff: number, type: number): Promise<string | null> {
    const cache = await this.cacheModel
      .findOne({ jobId, diff, type })
      .select('html')
      .lean();

    if (cache) {
      this.logger.log(`Cache hit for job ${jobId}, diff ${diff}, type ${type}`);
      return cache.html;
    }

    return null;
  }

  /**
   * 设置缓存
   */
  async set(jobId: string, diff: number, type: number, html: string) {
    const now = new Date();

    await this.cacheModel.updateOne(
      { jobId, diff, type },
      {
        $set: {
          jobId,
          diff,
          type,
          html,
          createdAt: now,
        },
      },
      { upsert: true },
    );

    this.logger.log(`Cache set for job ${jobId}, diff ${diff}, type ${type}`);
  }

  /**
   * 删除指定 job 的所有缓存
   */
  async deleteByJobId(jobId: string): Promise<number> {
    const result = await this.cacheModel.deleteMany({ jobId });
    const count = result.deletedCount ?? 0;

    if (count > 0) {
      this.logger.log(`Deleted ${count} cache entries for job ${jobId}`);
    }

    return count;
  }

  /**
   * 清理过期的缓存（兜底方法，主要依靠 TTL 索引）
   * 删除创建时间超过 12 小时的记录
   * 每天凌晨 3 点执行
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'Asia/Shanghai' })
  async cleanupExpired(): Promise<number> {
    this.logger.log('Running scheduled cleanup of expired cache entries...');
    const cutoffTime = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const result = await this.cacheModel.deleteMany({
      createdAt: { $lt: cutoffTime },
    });

    const count = result.deletedCount ?? 0;
    if (count > 0) {
      this.logger.log(`Cleaned up ${count} expired cache entries`);
    } else {
      this.logger.log('No expired cache entries found');
    }

    return count;
  }
}
