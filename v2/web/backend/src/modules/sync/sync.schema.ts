import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';

export type SyncScore = {
  musicId: string;
  cid: number;
  chartIndex: number;
  category: string | null;
  type: string;
  title: string;
  dxScore: string | null;
  score: string | null;
  fs: string | null;
  fc: string | null;
  rating: number | null;
  musicDetailLevel: number | null;
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
}

export type SyncDocument = HydratedDocument<SyncEntity>;
export const SyncSchema = SchemaFactory.createForClass(SyncEntity);
