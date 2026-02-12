import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'idle_update_logs' })
export class IdleUpdateLogEntity {
  /** 日期 key，如 "2025-01-15"，唯一索引防止同一天多次触发 */
  @Prop({ required: true, unique: true, index: true })
  dateKey!: string;

  @Prop({ required: true })
  triggeredAt!: Date;

  /** 运行状态: running → completed */
  @Prop({ type: String, default: 'running' })
  status!: string;

  @Prop({ type: Number, default: 0 })
  totalUsers!: number;

  @Prop({ type: Number, default: 0 })
  created!: number;

  @Prop({ type: Number, default: 0 })
  failed!: number;

  /** 每个被更新的 friendCode 及其对应的 jobId */
  @Prop({
    type: [{ friendCode: String, jobId: String }],
    default: [],
  })
  entries!: Array<{ friendCode: string; jobId: string }>;
}

export type IdleUpdateLogDocument = HydratedDocument<IdleUpdateLogEntity>;
export const IdleUpdateLogSchema =
  SchemaFactory.createForClass(IdleUpdateLogEntity);
