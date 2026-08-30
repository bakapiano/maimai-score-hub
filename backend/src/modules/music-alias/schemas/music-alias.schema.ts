import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export const MUSIC_ALIAS_SOURCES = ['yuzuchan', 'lxns'] as const;
export type MusicAliasSource = (typeof MUSIC_ALIAS_SOURCES)[number];

@Schema({ collection: 'music_aliases', timestamps: true })
export class MusicAliasEntity {
  @Prop({ type: String, required: true, enum: MUSIC_ALIAS_SOURCES })
  source!: MusicAliasSource;

  @Prop({ required: true })
  sourceMusicId!: string;

  @Prop({ type: [String], default: [] })
  musicIds!: string[];

  @Prop({ required: true })
  alias!: string;

  @Prop({ required: true })
  normalizedAlias!: string;

  @Prop({ required: true })
  syncRunId!: string;

  @Prop({ required: true })
  syncedAt!: Date;
}

export type MusicAliasDocument = HydratedDocument<MusicAliasEntity>;
export const MusicAliasSchema = SchemaFactory.createForClass(MusicAliasEntity);

MusicAliasSchema.index(
  { source: 1, sourceMusicId: 1, normalizedAlias: 1 },
  { unique: true },
);
MusicAliasSchema.index({ musicIds: 1 });
MusicAliasSchema.index({ source: 1, syncRunId: 1 });
