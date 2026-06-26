import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'system_settings', timestamps: true })
export class SystemSettingsEntity {
  @Prop({ required: true, unique: true, default: 'default' })
  key!: string;

  @Prop({ required: true, type: Boolean, default: false })
  cabinetOnlyMode!: boolean;
}

export type SystemSettingsDocument = HydratedDocument<SystemSettingsEntity>;
export const SystemSettingsSchema =
  SchemaFactory.createForClass(SystemSettingsEntity);
