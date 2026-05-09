import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import type { UserNetProfile } from './user.types';

@Schema({ timestamps: true })
export class UserEntity {
  @Prop({ required: true, unique: true, index: true })
  friendCode!: string;

  @Prop({ type: String, default: null })
  divingFishImportToken!: string | null;

  @Prop({ type: String, default: null })
  lxnsImportToken!: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: undefined })
  profile?: UserNetProfile | null;

  @Prop({ type: String, default: null })
  idleUpdateBotFriendCode!: string | null;

  @Prop({ type: Boolean, default: false })
  autoExportDivingFish!: boolean;

  @Prop({ type: Boolean, default: false })
  autoExportLxns!: boolean;

  @Prop({ type: Date, default: null })
  lastActiveAt!: Date | null;

  @Prop({ type: String, default: null })
  preferredBotFriendCode!: string | null;

  /**
   * Numeric maimai cabinet userId, populated by scanning the player's card
   * QR through the sdgb-worker. null = unbound.
   */
  @Prop({ type: Number, default: null })
  cabinetUserId!: number | null;

  /**
   * Whether the auto-update scheduler should poll this user's score hash
   * and trigger refresh jobs. Requires cabinetUserId to be set.
   */
  @Prop({ type: Boolean, default: false })
  autoUpdate!: boolean;

  /**
   * MD5 of the last (musicId,level,achievement,deluxscoreMax) tuples
   * we observed for this user via sdgb-worker. Used to skip work when
   * nothing changed since the previous tick.
   */
  @Prop({ type: String, default: null })
  lastScoreHash!: string | null;

  /**
   * Last time AutoUpdateScheduler actually called sdgb-worker to fetch
   * this user's hash. Throttle: at most once per 15 min per user, even
   * across backend instances.
   */
  @Prop({ type: Date, default: null })
  lastHashCheckAt!: Date | null;

  /**
   * Last time AutoUpdateScheduler actually created an idle_update_score
   * job for this user. Throttle: at most once per 30 min per user.
   * Combined with an in-flight check (any queued/processing job for the
   * same friendCode → skip), this prevents both fan-out under failure
   * and back-to-back jobs canceling each other out via the
   * "JobService.create cancels older jobs" rule.
   */
  @Prop({ type: Date, default: null })
  lastAutoUpdateJobAt!: Date | null;
}

export type UserDocument = HydratedDocument<UserEntity>;
export const UserSchema = SchemaFactory.createForClass(UserEntity);
