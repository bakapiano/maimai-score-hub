import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument, Types } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export type SyncScore = {
  musicId: string;
  cid: string;
  chartIndex: number;
  type: string;
  dxScore: string | null;
  score: string | null;
  fs: string | null;
  fc: string | null;
  rating: number | null;
  isNew: boolean | null;
};

@Schema({ collection: 'syncs', timestamps: true })
export class SyncEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true, unique: true, index: true })
  friendCode!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  ownerUserId!: Types.ObjectId | null;

  /** Legacy source field retained during the stable-current migration. */
  @Prop({ type: String, default: null })
  jobId!: string | null;

  @Prop({ type: [Object], default: [] })
  scores!: SyncScore[];

  @Prop({ type: String, default: null })
  lastSourceType!: string | null;

  @Prop({ type: String, default: null })
  lastSourceId!: string | null;

  @Prop({ type: Date, default: null })
  lastMergedAt!: Date | null;

  @Prop({ type: Date, default: null })
  scoreUpdatedAt!: Date | null;

  /** Mongoose version key used as the score Compare-And-Set token. */
  __v!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type SyncDocument = HydratedDocument<SyncEntity>;
export const SyncSchema = SchemaFactory.createForClass(SyncEntity);

// Narrow covered read used by Prober Export reconciliation. The unique
// friendCode index above remains the canonical one-user-one-current fence.
SyncSchema.index(
  { friendCode: 1, __v: 1, id: 1 },
  { name: 'export_version_scan' },
);
SyncSchema.index({ jobId: 1 }, { name: 'by_legacy_source_job' });
