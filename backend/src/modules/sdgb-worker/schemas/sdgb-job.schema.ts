import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export type SdgbJobType =
  | 'scan_qr'
  | 'get_rival_hash'
  | 'get_user_map'
  | 'add_rival';
export type SdgbJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

/**
 * Cabinet (sdgb-protocol) jobs. Decoupled from the existing `jobs` collection
 * because the lifecycle, payload shape and consumer (sdgb-worker) are all
 * different — sdgb-worker is a single-concurrency puller that should only
 * touch this collection, never the dxnet `jobs`.
 */
@Schema({ collection: 'sdgb_jobs', timestamps: true })
export class SdgbJobEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true, type: String, index: true })
  jobType!: SdgbJobType;

  @Prop({ required: true, type: String, index: true })
  status!: SdgbJobStatus;

  /**
   * Payload schema (per jobType):
   *   scan_qr:        { qrCode: string, callerUid?: number }
   *   get_rival_hash: { cabinetUserId: number, callerUid?: number }
   *   get_user_map:   { cabinetUserId: number }
   *   add_rival:      { botCabinetUserId: number, targetCabinetUserId: number }
   */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: Record<string, unknown>;

  /**
   * Result schema (per jobType):
   *   scan_qr:        { cabinetUserId: number, music: MusicEntry[], hash: string }
   *   get_rival_hash: { hash: string, music: MusicEntry[] }
   *   get_user_map:   { maps: UserMapEntry[] }
   *   add_rival:      { returnCode1: number, returnCode2: number }
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  result!: Record<string, unknown> | null;

  @Prop({ type: String, default: null })
  error!: string | null;

  /** Set when the BullMQ consumer starts work, cleared on terminal state. */
  @Prop({ type: Boolean, default: false })
  executing!: boolean;

  @Prop({ type: Date, default: null })
  claimedAt!: Date | null;

  /** Optional tag the producer can set so it can find back its own job. */
  @Prop({ type: String, default: null, index: true })
  requesterTag!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type SdgbJobDocument = HydratedDocument<SdgbJobEntity>;
export const SdgbJobSchema = SchemaFactory.createForClass(SdgbJobEntity);

// 1-day TTL — these jobs are short-lived; we only need them around long
// enough for the producer to read the result.
SdgbJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

// Hot-path compound indexes. The individual status_1 / jobType_1 /
// requesterTag_1 single-field indexes above can't serve the dispatcher
// queries that combine them, leading to COLLSCAN on 49k+ rows.
SdgbJobSchema.index({ status: 1, jobType: 1 }, { name: 'status_type' });
SdgbJobSchema.index(
  { jobType: 1, requesterTag: 1, createdAt: -1 },
  { name: 'by_requester' },
);

// Admin-dashboard hot paths (added 2026-05-30 after a 339s /status call):
//   - status_createdAt: serves `findOne({status:'queued'}).sort({createdAt:1})`
//   - status_claimedAt: serves `findOne({status:'processing'}).sort({claimedAt:1})`
//   - updatedAt: serves `.find().sort({updatedAt:-1}).limit(20)` for recentJobs
SdgbJobSchema.index({ status: 1, createdAt: 1 }, { name: 'status_createdAt' });
SdgbJobSchema.index({ status: 1, claimedAt: 1 }, { name: 'status_claimedAt' });
SdgbJobSchema.index({ updatedAt: -1 }, { name: 'updatedAt_desc' });
