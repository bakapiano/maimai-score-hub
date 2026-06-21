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
   * Last time AutoUpdateScheduler actually created an update_score
   * job for this user. Throttle: at most once per 30 min per user.
   * Combined with an in-flight check (any queued/processing job for the
   * same friendCode → skip), this prevents both fan-out under failure
   * and back-to-back jobs canceling each other out via the
   * "JobService.create cancels older jobs" rule.
   */
  @Prop({ type: Date, default: null })
  lastAutoUpdateJobAt!: Date | null;

  /**
   * Number of consecutive failed `update_score` jobs created by
   * AutoUpdateScheduler for this user. Reset to 0 whenever a job
   * completes successfully or when an admin manually triggers a
   * refresh. Drives the exponential backoff window below.
   *
   * Only counts dxnet job failures (status=failed). Transient
   * sdgb getRivalHash / addRival errors do NOT increment this — they
   * have their own per-call retry/swallow logic and would otherwise
   * cause cabinet network blips to push a user into long backoff.
   */
  @Prop({ type: Number, default: 0 })
  autoUpdateFailureCount!: number;

  /**
   * Earliest wall-clock time at which AutoUpdateScheduler is allowed
   * to run the hash-check + job-creation flow again for this user.
   * Computed as `now + base * 2^(failureCount-1)` capped at
   * AUTO_UPDATE_BACKOFF_CAP_MS each time we record a failure.
   * null = no active backoff.
   */
  @Prop({ type: Date, default: null })
  autoUpdateBackoffUntil!: Date | null;

  createdAt!: Date;

  updatedAt!: Date;
}

export type UserDocument = HydratedDocument<UserEntity>;
export const UserSchema = SchemaFactory.createForClass(UserEntity);

UserSchema.index(
  { autoUpdate: 1, cabinetUserId: 1 },
  { name: 'auto_update_cabinet' },
);
UserSchema.index({ createdAt: -1 }, { name: 'createdAt_desc' });
