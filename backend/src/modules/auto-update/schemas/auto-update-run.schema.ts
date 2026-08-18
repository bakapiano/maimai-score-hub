import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * One row per auto-update sweep tick or daily batch. The unique `bucketKey`
 * index (for example "2026-05-09T14:15",
 * "fcfs-score-window:2026-05-09T14:30", or
 * "daily-full-update:2026-05-09") is the durable once-only fence.
 *
 * Modeled after the former nightly-update log, so
 * an admin reading the two collections side by side gets the same shape.
 */
@Schema({ collection: 'auto_update_runs' })
export class AutoUpdateRunEntity {
  /** Cron minute bucket or a prefixed business-date batch key. */
  @Prop({ required: true, unique: true, index: true })
  bucketKey!: string;

  @Prop({ required: true })
  triggeredAt!: Date;

  /** Which instance won the sweep (process.env.HOSTNAME or "unknown"). */
  @Prop({ type: String, default: 'unknown' })
  ranOn!: string;

  @Prop({ type: String, default: 'running' })
  status!: 'running' | 'completed';

  @Prop({ type: Number, default: 0 })
  totalUsers!: number;

  @Prop({ type: Number, default: 0 })
  triggered!: number;

  @Prop({ type: Number, default: 0 })
  skippedNoChange!: number;

  @Prop({ type: Number, default: 0 })
  failed!: number;
}

export type AutoUpdateRunDocument = HydratedDocument<AutoUpdateRunEntity>;
export const AutoUpdateRunSchema =
  SchemaFactory.createForClass(AutoUpdateRunEntity);

// 30-day TTL — cheap to keep around for a few weeks, useful for debugging
// "did the cron actually fire on instance X at time Y?".
AutoUpdateRunSchema.index(
  { triggeredAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);
