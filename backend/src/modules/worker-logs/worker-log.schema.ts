import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type WorkerLogLevel = 'log' | 'warn' | 'error';

/**
 * One row per console line shipped by a worker. Workers buffer locally
 * and POST batches to /api/worker-logs every few seconds, so this
 * collection grows fast — keep the per-row payload tight and rely on a
 * TTL index to drop old rows.
 */
@Schema({ collection: 'worker_logs' })
export class WorkerLogEntity {
  /** Free-form worker identity, e.g. "sdgb-worker-bakapiano-101". */
  @Prop({ required: true, index: true })
  workerId!: string;

  /** Which worker fleet, used for filtering in the admin UI. */
  @Prop({ required: true, type: String, index: true })
  workerKind!: 'sdgb' | 'dxnet';

  /** When the line was emitted on the worker side (worker clock). */
  @Prop({ required: true, type: Date, index: true })
  ts!: Date;

  @Prop({ required: true, type: String })
  level!: WorkerLogLevel;

  /** Already-formatted message — workers do the stringify. */
  @Prop({ required: true, type: String })
  message!: string;
}

export type WorkerLogDocument = HydratedDocument<WorkerLogEntity>;
export const WorkerLogSchema = SchemaFactory.createForClass(WorkerLogEntity);

// 24h TTL — these are firehose-style logs, not audit. Tune via env if
// you ever want to keep more, but anything past a day is faster to grep
// from the worker container itself.
const TTL_SECONDS = parseInt(
  process.env.WORKER_LOGS_TTL_SECONDS || String(24 * 60 * 60),
  10,
);
WorkerLogSchema.index({ ts: 1 }, { expireAfterSeconds: TTL_SECONDS });
