import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type {
  SdgbHookObservation,
  SdgbMaintenanceReason,
  SdgbMaintenanceState,
  SdgbWorkerClass,
  SdgbWorkerLane,
} from '@maimai-score-hub/shared';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export interface SdgbLaneCoveragePlan {
  workerClass: SdgbWorkerClass;
  targetCount: number;
  selectedWorkerIds: string[];
}

@Schema({ collection: 'sdgb_maintenance_runs', timestamps: true })
export class SdgbMaintenanceRunEntity {
  @Prop({ required: true, unique: true, index: true })
  requestId!: string;

  @Prop({ required: true, index: true })
  targetWorkerId!: string;

  @Prop({ required: true, type: [String] })
  affectedLanes!: SdgbWorkerLane[];

  @Prop({ required: true })
  hookKind!: string;

  @Prop({ required: true, type: String })
  reason!: SdgbMaintenanceReason;

  @Prop({ required: true, type: String, index: true })
  state!: SdgbMaintenanceState;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  coveragePlanByLane!: Partial<Record<SdgbWorkerLane, SdgbLaneCoveragePlan>>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  activeMembersBeforeByLane!: Partial<Record<SdgbWorkerLane, string[]>>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  activeMembersAtHookByLane!: Partial<Record<SdgbWorkerLane, string[]>>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  activeMembersAfterByLane!: Partial<Record<SdgbWorkerLane, string[]>>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  hookObservation!: SdgbHookObservation | null;

  @Prop({ default: 0 })
  healthSuccesses!: number;

  @Prop({ default: 0 })
  healthFailures!: number;

  @Prop({ type: Date, default: null })
  healthWindowStartedAt!: Date | null;

  @Prop({ type: Date, default: null })
  healthLastCheckedAt!: Date | null;

  @Prop({ type: Date, required: true })
  deadlineAt!: Date;

  @Prop({ type: String, default: null })
  errorCode!: string | null;

  @Prop({ type: String, default: null })
  errorMessage!: string | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type SdgbMaintenanceRunDocument =
  HydratedDocument<SdgbMaintenanceRunEntity>;
export const SdgbMaintenanceRunSchema = SchemaFactory.createForClass(
  SdgbMaintenanceRunEntity,
);

SdgbMaintenanceRunSchema.index({ state: 1, updatedAt: 1 });
SdgbMaintenanceRunSchema.index({ targetWorkerId: 1, createdAt: -1 });
SdgbMaintenanceRunSchema.index(
  { completedAt: 1 },
  {
    expireAfterSeconds: 180 * 24 * 60 * 60,
    partialFilterExpression: { completedAt: { $type: 'date' } },
  },
);
