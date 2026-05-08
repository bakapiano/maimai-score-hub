import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'bot_statuses' })
export class BotStatusEntity {
  @Prop({ required: true, unique: true, index: true })
  friendCode!: string;

  @Prop({ required: true })
  available!: boolean;

  @Prop({ required: true })
  lastReportedAt!: Date;

  @Prop({ type: Number, default: null })
  friendCount!: number | null;

  @Prop({ type: String, default: null })
  remark!: string | null;

  /** 是否已发送过不可用通知（用于去重） */
  @Prop({ type: Boolean, default: false })
  notifiedUnavailable!: boolean;

  /**
   * Numeric cabinet userId for this bot. Used by the auto-update scheduler
   * as the `userId1` of UserFriendRegistApi when adding a user as the bot's
   * rival on the cabinet side. null = bot cannot perform sdgb operations yet.
   */
  @Prop({ type: Number, default: null })
  cabinetUserId!: number | null;
}

export type BotStatusDocument = HydratedDocument<BotStatusEntity>;
export const BotStatusSchema = SchemaFactory.createForClass(BotStatusEntity);
