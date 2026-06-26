import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

/**
 * 通知状态持久化（MongoDB）
 * 用于多实例部署时通过原子操作避免重复发送通知
 */
@Schema({ collection: 'notify_state' })
export class NotifyStateEntity {
  /** 通知类型标识，如 'all_bots_down' */
  @Prop({ required: true, unique: true, index: true })
  key!: string;

  /** 是否已发送过通知 */
  @Prop({ required: true, default: false })
  notified!: boolean;

  /** 上次发送通知的时间 */
  @Prop({ type: Date, default: null })
  lastNotifiedAt!: Date | null;
}

export type NotifyStateDocument = HydratedDocument<NotifyStateEntity>;
export const NotifyStateSchema =
  SchemaFactory.createForClass(NotifyStateEntity);
