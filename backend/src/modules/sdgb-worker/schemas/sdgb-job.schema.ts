import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export type SdgbJobType =
  | 'scan_qr'
  | 'get_rival_hash'
  | 'get_user_map'
  | 'add_rival'
  | 'get_music_score';
export type SdgbJobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type SdgbJobStage =
  | 'queued'
  | 'qr_auth'
  | 'preview'
  | 'login'
  | 'get_music'
  | 'logout'
  | 'cleanup'
  | 'persist';
export type SdgbSessionCleanupStatus =
  | 'not_required'
  | 'pending'
  | 'succeeded'
  | 'unconfirmed';
export type SdgbWorkerLane = 'probe' | 'interactive';
export type SdgbFailureClass =
  | 'empty_response'
  | 'network_error'
  | 'timeout'
  | 'invalid_response'
  | 'outcome_unknown'
  | 'membership_lost';

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
  lane!: SdgbWorkerLane;

  @Prop({ required: true, type: Number, default: 1 })
  routingVersion!: number;

  @Prop({ required: true, type: String, index: true })
  status!: SdgbJobStatus;

  @Prop({ type: String, default: null })
  stage!: SdgbJobStage | null;

  @Prop({ type: String, default: 'not_required', index: true })
  cleanupStatus!: SdgbSessionCleanupStatus;

  @Prop({ type: String, default: null })
  cleanupErrorCode!: string | null;

  @Prop({ type: Date, default: null })
  cleanupUpdatedAt!: Date | null;

  @Prop({ type: Date, default: null })
  cleanupBlockedUntil!: Date | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  progress!: { detailsFetched: number } | null;

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

  @Prop({ type: String, default: null })
  errorCode!: string | null;

  /** Set when the BullMQ consumer starts work, cleared on terminal state. */
  @Prop({ type: Boolean, default: false })
  executing!: boolean;

  @Prop({ type: Date, default: null })
  claimedAt!: Date | null;

  @Prop({ type: String, default: null })
  executionToken!: string | null;

  @Prop({ type: String, default: null, index: true })
  executionWorkerId!: string | null;

  @Prop({ type: Number, default: null })
  executionMembershipEpoch!: number | null;

  @Prop({ type: Number, default: null })
  executionNetworkEpoch!: number | null;

  @Prop({ type: Number, required: true, default: 0 })
  attempt!: number;

  @Prop({ type: Number, required: true, default: 3 })
  maxAttempts!: number;

  @Prop({ type: Date, default: null })
  retryAt!: Date | null;

  @Prop({ type: String, default: null })
  retryReason!: string | null;

  @Prop({ type: String, default: null })
  failureClass!: SdgbFailureClass | null;

  @Prop({ type: String, default: null })
  lastWorkerId!: string | null;

  @Prop({ type: Boolean, default: false })
  outcomeUnknown!: boolean;

  /** Optional tag the producer can set so it can find back its own job. */
  @Prop({ type: String, default: null, index: true })
  requesterTag!: string | null;

  @Prop({ type: String, default: null, index: true })
  ownerUserId!: string | null;

  @Prop({ type: String, default: null, index: true })
  ownerFriendCode!: string | null;

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
  { status: 1, lane: 1, retryAt: 1, createdAt: 1 },
  { name: 'status_lane_retry' },
);
SdgbJobSchema.index(
  { executionWorkerId: 1, status: 1 },
  { name: 'execution_worker_status' },
);
SdgbJobSchema.index({ lane: 1, createdAt: -1 }, { name: 'lane_created' });
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
SdgbJobSchema.index(
  { ownerUserId: 1, jobType: 1, status: 1, createdAt: -1 },
  { name: 'owner_type_status' },
);
SdgbJobSchema.index(
  { ownerUserId: 1, cleanupStatus: 1, cleanupBlockedUntil: 1 },
  { name: 'owner_cleanup' },
);
