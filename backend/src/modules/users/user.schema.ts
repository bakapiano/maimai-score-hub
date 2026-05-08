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
}

export type UserDocument = HydratedDocument<UserEntity>;
export const UserSchema = SchemaFactory.createForClass(UserEntity);
