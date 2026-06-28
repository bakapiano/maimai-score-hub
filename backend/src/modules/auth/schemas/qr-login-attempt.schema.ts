import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type QrLoginStatus =
  | 'pending'
  | 'adding_rival'
  | 'waiting_snapshot'
  | 'matched'
  | 'failed';

/**
 * Tracks one QR-login attempt.
 *
 * The synchronous /auth/qr-login endpoint enqueues this row, kicks
 * off the slow-path machinery in the background, and returns
 * { attemptId } to the FE. The FE then polls /auth/qr-login/:id
 * until status becomes `matched` (with token) or `failed` (with error).
 *
 * Fast path (cabinetUserId already bound to a user) skips this entirely
 * — it returns { token, user } from the original POST.
 */
@Schema({ collection: 'qr_login_attempts', timestamps: true })
export class QrLoginAttemptEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true, type: String })
  status!: QrLoginStatus;

  @Prop({ required: true, type: Number })
  cabinetUserId!: number;

  @Prop({ type: String, default: null })
  rivalName!: string | null;

  @Prop({ type: Number, default: null })
  computedRating!: number | null;

  @Prop({ type: String, default: null })
  botUserFriendCode!: string | null;

  /** Set when status becomes 'matched'. */
  @Prop({ type: String, default: null })
  resolvedFriendCode!: string | null;

  /** Set when status becomes 'matched'. */
  @Prop({ type: String, default: null })
  token!: string | null;

  /** Set when status becomes 'failed'. */
  @Prop({ type: String, default: null })
  error!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type QrLoginAttemptDocument = HydratedDocument<QrLoginAttemptEntity>;
export const QrLoginAttemptSchema =
  SchemaFactory.createForClass(QrLoginAttemptEntity);

// 1-day TTL — these are short-lived; FE polls within ~60s and either
// gets the token or the failure message.
QrLoginAttemptSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60 },
);
