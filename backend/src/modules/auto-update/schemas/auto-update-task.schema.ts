import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export type AutoUpdateTaskType =
  | 'rival_score_probe'
  | 'map_auxiliary_probe'
  | 'fcfs_enrichment';

export type AutoUpdateTaskStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';

@Schema({ collection: 'auto_update_tasks', timestamps: true })
export class AutoUpdateTaskEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true, type: String, index: true })
  type!: AutoUpdateTaskType;

  @Prop({ required: true, index: true })
  friendCode!: string;

  @Prop({ required: true, index: true })
  cabinetUserId!: number;

  @Prop({ required: true, type: String, index: true })
  status!: AutoUpdateTaskStatus;

  @Prop({ type: Number, default: 0 })
  priority!: number;

  @Prop({ type: Date, default: null, index: true })
  runAt!: Date | null;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: String, default: null })
  lastError!: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  metrics!: Record<string, unknown> | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AutoUpdateTaskDocument = HydratedDocument<AutoUpdateTaskEntity>;
export const AutoUpdateTaskSchema =
  SchemaFactory.createForClass(AutoUpdateTaskEntity);

AutoUpdateTaskSchema.index(
  { type: 1, status: 1, runAt: 1 },
  { name: 'type_status_due' },
);
AutoUpdateTaskSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 3 * 24 * 60 * 60 },
);
