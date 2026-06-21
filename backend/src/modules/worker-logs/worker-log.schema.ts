import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type WorkerLogLevel = 'log' | 'warn' | 'error';

/**
 * One row per console line shipped by a worker. Workers buffer locally
 * and POST batches to /api/v1/workers/logs/:kind/batches every few seconds, so this
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

// 2h TTL — these are firehose-style logs (~50/s with 3 workers = 360k
// rows/2h). 24h was producing 4.3M rows which made any unindexed scan
// painful. Tune via env if you ever want longer retention, but anything
// past a couple hours is faster to grep from the worker container itself.
const TTL_SECONDS = parseInt(
  process.env.WORKER_LOGS_TTL_SECONDS || String(2 * 60 * 60),
  10,
);
WorkerLogSchema.index({ ts: 1 }, { expireAfterSeconds: TTL_SECONDS });

// Hot query: admin UI fetches "tail of this worker" → find({workerId, ts:$gte}).sort({ts:-1}).
// Compound (workerId, ts desc) covers it; single-field ts_1 from TTL
// above is not enough on a 4M-row table.
WorkerLogSchema.index({ workerId: 1, ts: -1 }, { name: 'by_worker_recent' });
WorkerLogSchema.index({ workerKind: 1, ts: -1 }, { name: 'by_kind_recent' });
