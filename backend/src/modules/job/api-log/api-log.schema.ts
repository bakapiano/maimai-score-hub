import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

/**
 * Job API 调用日志实体
 * 记录 bot 在处理 job 时每次 API 调用的 response 信息
 * 用于 admin 调试
 */
@Schema({ collection: 'job_api_logs' })
export class JobApiLogEntity {
  @Prop({ required: true, index: true })
  jobId!: string;

  @Prop({ required: true })
  url!: string;

  @Prop({ required: true })
  method!: string;

  @Prop({ required: true })
  statusCode!: number;

  @Prop({ type: String, default: null })
  responseBody!: string | null;

  @Prop({ required: true, index: true })
  createdAt!: Date;
}

export type JobApiLogDocument = HydratedDocument<JobApiLogEntity>;
export const JobApiLogSchema = SchemaFactory.createForClass(JobApiLogEntity);

// 设置 24 小时 TTL 索引，自动清理过期数据
JobApiLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
