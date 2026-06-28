import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export type ProberExportProvider = 'divingFish' | 'lxns';
export type ProberExportTrigger =
  | 'dxnet_update_score'
  | 'auto_update_rival'
  | 'auto_update_fcfs'
  | 'manual';
export type ProberExportStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'partial_failed'
  | 'failed'
  | 'skipped';
export type ProberExportProviderStatus = 'success' | 'failed' | 'skipped';

export type ProberExportProviderResult = {
  status: ProberExportProviderStatus;
  exported?: number;
  skipped?: number;
  scores?: number;
  message?: string;
  response?: unknown;
};

export type ProberExportResult = {
  divingFish?: ProberExportProviderResult | null;
  lxns?: ProberExportProviderResult | null;
};

@Schema({ collection: 'prober_export_jobs', timestamps: true })
export class ProberExportJobEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true, type: String, index: true })
  trigger!: ProberExportTrigger;

  @Prop({ required: true, type: String, index: true })
  friendCode!: string;

  @Prop({ required: true, type: String, index: true })
  syncId!: string;

  @Prop({ type: String, default: null })
  sourceJobId!: string | null;

  @Prop({ type: String, default: null })
  sourceTaskId!: string | null;

  @Prop({ type: [String], default: [] })
  targets!: ProberExportProvider[];

  @Prop({ required: true, type: String, index: true })
  status!: ProberExportStatus;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  result!: ProberExportResult | null;

  @Prop({ type: String, default: null })
  error!: string | null;

  @Prop({ type: Date, default: null })
  claimedAt!: Date | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ProberExportJobDocument = HydratedDocument<ProberExportJobEntity>;
export const ProberExportJobSchema = SchemaFactory.createForClass(
  ProberExportJobEntity,
);

ProberExportJobSchema.index(
  { trigger: 1, sourceJobId: 1 },
  {
    name: 'unique_source_job',
    unique: true,
    partialFilterExpression: { sourceJobId: { $type: 'string' } },
  },
);
ProberExportJobSchema.index(
  { trigger: 1, sourceTaskId: 1 },
  {
    name: 'unique_source_task',
    unique: true,
    partialFilterExpression: { sourceTaskId: { $type: 'string' } },
  },
);
ProberExportJobSchema.index(
  { syncId: 1, trigger: 1 },
  { name: 'sync_trigger' },
);
ProberExportJobSchema.index(
  { friendCode: 1, createdAt: -1 },
  { name: 'friend_recent' },
);
ProberExportJobSchema.index(
  { status: 1, createdAt: 1 },
  { name: 'status_createdAt' },
);
ProberExportJobSchema.index(
  { status: 1, claimedAt: 1 },
  { name: 'status_claimedAt' },
);
