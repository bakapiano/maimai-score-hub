import type { JobStage, JobStatus, JobType, ScoreProgress } from './job.types';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import type { UserNetProfile } from '../users/user.types';

@Schema({ collection: 'jobs' })
export class JobEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: true })
  friendCode!: string;

  @Prop({ required: true, type: String, default: 'send_friend_request' })
  jobType!: JobType;

  @Prop({ required: true, type: Number, default: 0 })
  priority!: number;

  @Prop({ required: true, default: false })
  skipUpdateScore!: boolean;

  @Prop({ type: String, default: null })
  botUserFriendCode!: string | null;

  @Prop({ type: String, default: null })
  friendRequestSentAt!: string | null;

  @Prop({ type: String, default: null })
  friendRequestWaitStartedAt!: string | null;

  @Prop({ required: true, type: String })
  status!: JobStatus;

  @Prop({ required: true, type: String })
  stage!: JobStage;

  @Prop({ type: MongooseSchema.Types.Mixed, default: undefined })
  result?: any;

  @Prop({ type: MongooseSchema.Types.Mixed, default: undefined })
  profile?: UserNetProfile;

  @Prop({ type: String, default: null })
  error!: string | null;

  @Prop({ required: true, default: false })
  executing!: boolean;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  scoreProgress!: ScoreProgress | null;

  @Prop({ type: Number, default: null })
  updateScoreDuration!: number | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  autoExportResult!: {
    divingFish?: { status: string; message?: string } | null;
    lxns?: { status: string; message?: string } | null;
  } | null;

  @Prop({ required: true, default: false })
  isAuthenticated!: boolean;

  /**
   * Score hash observed by the auto-update sweep at the moment this job
   * was created. Set ONLY for jobType=`update_score` jobs created by
   * AutoUpdateScheduler. When the job completes successfully, JobService
   * uses this to advance the user's `lastScoreHash` — that way a failed
   * job doesn't burn the hash transition the next sweep should retry.
   */
  @Prop({ type: String, default: null })
  sourceScoreHash!: string | null;

  /**
   * Cabinet-derived score data captured at job creation time. Worker
   * uses this to skip half the friend-VS requests (achievement +
   * dxScore are authoritative from cabinet; only fc/fs need scraping).
   * Shape: { "<musicId>_<chartIndex>": { achievement, dxScore } }.
   * Only populated for update_score jobs from AutoUpdateScheduler.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  cabinetScoreMap!: Record<string, { achievement: number; dxScore: number }> | null;

  /**
   * Subset of difficulties to scrape via friend-VS. When set, worker
   * only fetches these (typical: only diffs whose cabinet scores
   * changed since last sync). When null, worker uses its default set.
   */
  @Prop({ type: [Number], default: null })
  diffsToScrape!: number[] | null;

  /**
   * Next time this job may be claimed. Null means immediately claimable.
   * Used for waiting/cooldown stages so updatedAt stays a real audit field.
   */
  @Prop({ type: Date, default: null })
  runAt!: Date | null;

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type JobDocument = HydratedDocument<JobEntity>;
export const JobSchema = SchemaFactory.createForClass(JobEntity);

// 7 天 TTL 索引，自动清理过期 job
JobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// Hot-path indexes. Before these, the `jobs` collection only had
// _id / id / createdAt (TTL), and every claimNext + stale-lock release
// + pickAvailableCabinetBot bot-load aggregation did a full COLLSCAN.
// With cabinet-only mode driving request volume up, this overloaded
// mongo (169% CPU) on 2026-05-29.
JobSchema.index(
  { status: 1, botUserFriendCode: 1, executing: 1 },
  { name: 'hot_claim' },
);
JobSchema.index({ executing: 1, updatedAt: 1 }, { name: 'stale_lock' });
JobSchema.index(
  { status: 1, botUserFriendCode: 1, executing: 1, runAt: 1 },
  { name: 'hot_claim_due' },
);
JobSchema.index(
  {
    status: 1,
    botUserFriendCode: 1,
    executing: 1,
    runAt: 1,
    priority: -1,
    updatedAt: 1,
  },
  { name: 'hot_claim_priority' },
);
JobSchema.index(
  { botUserFriendCode: 1, status: 1 },
  { name: 'bot_status' },
);
JobSchema.index(
  { skipUpdateScore: 1, status: 1, createdAt: 1 },
  { name: 'admin_stats_status_createdAt' },
);
JobSchema.index(
  { skipUpdateScore: 1, status: 1, updateScoreDuration: 1, createdAt: 1 },
  { name: 'admin_stats_duration' },
);
JobSchema.index(
  { jobType: 1, friendCode: 1, createdAt: -1 },
  { name: 'latest_by_type_friend' },
);
JobSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'status_createdAt_desc' },
);
