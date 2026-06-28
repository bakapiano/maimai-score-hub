import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import type { UserNetProfile } from '../user.types';

@Schema({ timestamps: true })
export class UserEntity {
  @Prop({ required: true, unique: true, index: true })
  friendCode!: string;

  @Prop({ type: String, default: null })
  username!: string | null;

  @Prop({ type: String, default: null, select: false })
  passwordHash!: string | null;

  @Prop({ type: Date, default: null })
  passwordUpdatedAt!: Date | null;

  @Prop({ type: String, default: null })
  divingFishImportToken!: string | null;

  @Prop({ type: String, default: null })
  lxnsImportToken!: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: undefined })
  profile?: UserNetProfile | null;

  @Prop({ type: Date, default: null })
  lastActiveAt!: Date | null;

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

  createdAt!: Date;

  updatedAt!: Date;
}

export type UserDocument = HydratedDocument<UserEntity>;
export const UserSchema = SchemaFactory.createForClass(UserEntity);

UserSchema.index(
  { autoUpdate: 1, cabinetUserId: 1 },
  { name: 'auto_update_cabinet' },
);
UserSchema.index(
  { username: 1 },
  {
    name: 'username_unique',
    unique: true,
    partialFilterExpression: { username: { $type: 'string' } },
  },
);
UserSchema.index({ createdAt: -1 }, { name: 'createdAt_desc' });
