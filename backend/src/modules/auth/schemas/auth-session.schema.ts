import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  Schema as MongooseSchema,
  Types,
  type HydratedDocument,
} from 'mongoose';

import { UserEntity } from '../../users/schemas/user.schema';

@Schema({ timestamps: true, collection: 'auth_sessions' })
export class AuthSessionEntity {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: UserEntity.name,
    required: true,
    index: true,
  })
  userId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: String, default: null, index: true })
  previousTokenHash!: string | null;

  @Prop({ type: Date, default: null })
  rotatedAt!: Date | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  deviceLabel!: string;

  @Prop({ type: String, default: null, maxlength: 300 })
  userAgent!: string | null;

  @Prop({ type: Date, required: true })
  lastUsedAt!: Date;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  createdAt!: Date;

  updatedAt!: Date;
}

export type AuthSessionDocument = HydratedDocument<AuthSessionEntity>;
export const AuthSessionSchema =
  SchemaFactory.createForClass(AuthSessionEntity);

AuthSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'auth_session_ttl' },
);
AuthSessionSchema.index(
  { userId: 1, revokedAt: 1, lastUsedAt: -1 },
  { name: 'auth_session_user_active' },
);
