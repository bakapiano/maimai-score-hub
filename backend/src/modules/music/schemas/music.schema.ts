import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';
import { SchemaTypes } from 'mongoose';

export type ChartNotesSD = {
  tap: number;
  hold: number;
  slide: number;
  break: number;
};

export type ChartNotesDX = ChartNotesSD & {
  touch: number;
};

export type ChartNotes = ChartNotesSD | ChartNotesDX;

export type ChartPayload = {
  cid?: string;
  level?: string;
  detailLevel?: number;
  notes?: unknown;
  charter?: string;
};

export interface SongMetadata {
  title?: string;
  artist?: string;
  category?: string;
  bpm?: number | string | null;
  from?: string | null;
  isNew?: boolean;
}

@Schema({ collection: 'musics', timestamps: true })
export class MusicEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true })
  title!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ type: String, default: null })
  artist!: string | null;

  @Prop({ type: String, default: null })
  category!: string | null;

  @Prop({ type: SchemaTypes.Mixed, default: null })
  bpm!: number | string | null;

  @Prop({ type: String, default: null })
  version!: string | null;

  @Prop({ type: Boolean, default: null })
  isNew!: boolean | null;

  @Prop({ type: SchemaTypes.Mixed, default: [] })
  charts!: ChartPayload[];

  @Prop({ type: Object, default: null })
  sync!: {
    createdAt?: Date | null;
    updatedAt?: Date | null;
    lastSyncedAt?: Date | null;
  } | null;
}

export type MusicDocument = HydratedDocument<MusicEntity>;
export const MusicSchema = SchemaFactory.createForClass(MusicEntity);
