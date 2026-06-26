import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

/**
 * One row per bot friendCode. Workers report the bot's friend list
 * (friendCode + userName + rating per friend) on every status tick;
 * we full-overwrite here so a single doc always reflects reality.
 *
 * Used by the QR-login flow to reverse-map (cabinetUserName, computed
 * b50 rating) → friendCode for users who haven't bound their account yet.
 */
@Schema({ collection: 'bot_friend_snapshots' })
export class BotFriendSnapshotEntity {
  @Prop({ required: true, unique: true, index: true })
  botFriendCode!: string;

  @Prop({
    type: [
      {
        _id: false,
        friendCode: { type: String, required: true },
        userName: { type: String, default: null },
        rating: { type: Number, default: null },
      },
    ],
    default: [],
  })
  friends!: Array<{
    friendCode: string;
    userName: string | null;
    rating: number | null;
  }>;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type BotFriendSnapshotDocument =
  HydratedDocument<BotFriendSnapshotEntity>;
export const BotFriendSnapshotSchema = SchemaFactory.createForClass(
  BotFriendSnapshotEntity,
);

// 30-day TTL on updatedAt — if a bot stops reporting for a month its snapshot
// is dropped so the QR-login flow doesn't keep matching against stale names.
BotFriendSnapshotSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);
// Mongoose's Mixed type isn't required; the per-friend shape is fixed above.
void MongooseSchema; // keep import linter-quiet
