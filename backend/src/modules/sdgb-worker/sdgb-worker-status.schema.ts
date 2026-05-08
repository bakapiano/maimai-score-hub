import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * One row per sdgb-worker instance (we typically only run one). Updated on
 * every poll, regardless of whether a job was claimed — this gives the
 * admin UI a reliable "is the worker alive" signal that doesn't depend on
 * job traffic.
 */
@Schema({ collection: 'sdgb_worker_status', timestamps: true })
export class SdgbWorkerStatusEntity {
  @Prop({ required: true, unique: true, index: true })
  workerId!: string;

  @Prop({ required: true })
  lastSeenAt!: Date;

  /** Total jobs claimed by this worker since start. Best-effort, not durable. */
  @Prop({ type: Number, default: 0 })
  jobsClaimed!: number;
}

export type SdgbWorkerStatusDocument = HydratedDocument<SdgbWorkerStatusEntity>;
export const SdgbWorkerStatusSchema = SchemaFactory.createForClass(
  SdgbWorkerStatusEntity,
);
