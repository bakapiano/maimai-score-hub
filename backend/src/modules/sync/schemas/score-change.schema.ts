import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export type ScoreChangeSourceType =
  | 'dxnet_update_score'
  | 'auto_update_rival'
  | 'auto_update_fcfs'
  | 'cabinet_qr_update';

export type ScoreChangeField =
  | 'score'
  | 'dxScore'
  | 'fc'
  | 'fs'
  | 'rating'
  | 'newChart';

export type ScoreChangeValue = {
  score?: string | null;
  dxScore?: string | null;
  fc?: string | null;
  fs?: string | null;
  rating?: number | null;
};

@Schema({
  collection: 'score_changes',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ScoreChangeEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true, index: true })
  changeSetId!: string;

  @Prop({ required: true, index: true })
  friendCode!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  ownerUserId!: Types.ObjectId | null;

  @Prop({ required: true, type: Date, index: true })
  observedAt!: Date;

  @Prop({ required: true, type: String })
  sourceType!: ScoreChangeSourceType;

  @Prop({ required: true })
  sourceId!: string;

  @Prop({ required: true })
  syncId!: string;

  @Prop({ type: Number, default: null })
  beforeScoreVersion!: number | null;

  @Prop({ required: true, type: Number })
  afterScoreVersion!: number;

  @Prop({ required: true })
  musicId!: string;

  @Prop({ required: true, type: Number })
  chartIndex!: number;

  @Prop({ required: true })
  type!: string;

  @Prop({ type: Object, default: {} })
  before!: ScoreChangeValue;

  @Prop({ type: Object, default: {} })
  after!: ScoreChangeValue;

  @Prop({ type: [String], default: [] })
  changedFields!: ScoreChangeField[];

  @Prop({ type: Number, default: null })
  achievementDelta!: number | null;

  @Prop({ type: Number, default: null })
  dxScoreDelta!: number | null;

  @Prop({ type: Number, default: null })
  ratingDelta!: number | null;

  @Prop({ type: Number, default: null })
  fcRankDelta!: number | null;

  @Prop({ type: Number, default: null })
  fsRankDelta!: number | null;

  createdAt!: Date;
}

export type ScoreChangeDocument = HydratedDocument<ScoreChangeEntity>;
export const ScoreChangeSchema =
  SchemaFactory.createForClass(ScoreChangeEntity);

ScoreChangeSchema.index(
  { friendCode: 1, observedAt: -1, _id: -1 },
  { name: 'friend_timeline' },
);
ScoreChangeSchema.index({
  friendCode: 1,
  musicId: 1,
  chartIndex: 1,
  type: 1,
  observedAt: -1,
  _id: -1,
});
ScoreChangeSchema.index({ ownerUserId: 1, observedAt: -1 });
ScoreChangeSchema.index(
  { observedAt: 1, friendCode: 1 },
  { name: 'daily_changed_users' },
);
ScoreChangeSchema.index(
  { sourceType: 1, sourceId: 1, musicId: 1, chartIndex: 1 },
  { unique: true, name: 'source_chart_unique' },
);
