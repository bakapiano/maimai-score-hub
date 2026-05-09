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

  /**
   * Set by code paths that need a fresh friend list ASAP (currently:
   * QR-login, after addRival succeeds). Worker pulls a list of bots with
   * non-null `friendListRefreshRequestedAt` every few seconds and
   * fetches+reports their friend list out of band, then clears the field.
   */
  @Prop({ type: Date, default: null })
  friendListRefreshRequestedAt!: Date | null;
}

export type BotStatusDocument = HydratedDocument<BotStatusEntity>;
export const BotStatusSchema = SchemaFactory.createForClass(BotStatusEntity);
