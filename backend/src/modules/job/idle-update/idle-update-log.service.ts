import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { IdleUpdateLogEntity } from './idle-update-log.schema';

@Injectable()
export class IdleUpdateLogService {
  constructor(
    @InjectModel(IdleUpdateLogEntity.name)
    private readonly logModel: Model<IdleUpdateLogEntity>,
  ) {}

  /**
   * 尝试原子地获取某天的触发权。
   * 利用 dateKey 的唯一索引，只有第一个 instance 能成功 upsert，
   * 后续 instance 会发现文档已存在而放弃。
   *
   * @returns true 表示本 instance 获得触发权，false 表示已被其他 instance 触发。
   */
  async tryAcquire(dateKey: string): Promise<boolean> {
    const result = await this.logModel.findOneAndUpdate(
      { dateKey },
      {
        $setOnInsert: {
          dateKey,
          triggeredAt: new Date(),
          status: 'running',
          totalUsers: 0,
          created: 0,
          failed: 0,
          entries: [],
        },
      },
      { upsert: true, returnDocument: 'before' },
    );

    // result === null 表示之前不存在该文档，说明是本次 upsert 创建的
    return result === null;
  }

  /**
   * 更新触发日志的最终结果。
   */
  async finalize(
    dateKey: string,
    summary: {
      totalUsers: number;
      created: number;
      failed: number;
      entries: Array<{ friendCode: string; jobId: string }>;
    },
  ): Promise<void> {
    await this.logModel.updateOne(
      { dateKey },
      {
        $set: {
          status: 'completed',
          totalUsers: summary.totalUsers,
          created: summary.created,
          failed: summary.failed,
          entries: summary.entries,
        },
      },
    );
  }
}
