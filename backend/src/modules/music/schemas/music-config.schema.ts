import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type MusicDataSource = 'diving-fish' | 'lxns';

@Schema({ collection: 'music_config', timestamps: true })
export class MusicConfigEntity {
  @Prop({ required: true, unique: true, default: 'default' })
  key!: string;

  @Prop({ required: true, type: String, default: 'diving-fish' })
  dataSource!: MusicDataSource;
}

export type MusicConfigDocument = HydratedDocument<MusicConfigEntity>;
export const MusicConfigSchema =
  SchemaFactory.createForClass(MusicConfigEntity);
