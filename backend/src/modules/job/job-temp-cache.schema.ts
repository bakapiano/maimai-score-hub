import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

/**
 * Job 临时缓存实体
 * 用于存储 update_score 阶段的中间结果，支持 worker 崩溃后的任务恢复
 */
@Schema({ collection: 'job_temp_cache' })
export class JobTempCacheEntity {
  @Prop({ required: true, index: true })
  jobId!: string;

  @Prop({ required: true })
  diff!: number;

  @Prop({ required: true })
  type!: number; // 1 = dxScore, 2 = score

  @Prop({ required: true, type: String })
  html!: string;

  @Prop({ required: true, index: true })
  createdAt!: Date;
}

export type JobTempCacheDocument = HydratedDocument<JobTempCacheEntity>;
export const JobTempCacheSchema =
  SchemaFactory.createForClass(JobTempCacheEntity);

// 设置 1 小时 TTL 索引，自动清理过期数据
JobTempCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 1 * 60 * 60 });

// 创建复合索引以支持快速查询
JobTempCacheSchema.index({ jobId: 1, diff: 1, type: 1 }, { unique: true });
