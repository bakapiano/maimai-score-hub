import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

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

  @Prop({ required: true, index: true })
  jobId!: string;

  @Prop({ required: true })
  friendCode!: string;

  @Prop({ type: [Object], default: [] })
  scores!: SyncScore[];

  @Prop({ type: Object, default: null })
  autoExportResult!: {
    divingFish?: { status: string; message?: string } | null;
    lxns?: { status: string; message?: string } | null;
  } | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type SyncDocument = HydratedDocument<SyncEntity>;
export const SyncSchema = SchemaFactory.createForClass(SyncEntity);
