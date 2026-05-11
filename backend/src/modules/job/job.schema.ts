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

  @Prop({ required: true, type: String, default: 'immediate' })
  jobType!: JobType;

  @Prop({ required: true, default: false })
  skipUpdateScore!: boolean;

  @Prop({ required: true, default: false })
  fullSync!: boolean;

  @Prop({ type: String, default: null })
  botUserFriendCode!: string | null;

  @Prop({ type: String, default: null })
  friendRequestSentAt!: string | null;

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
   * was created. Set ONLY for jobType=`idle_update_score` jobs created by
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
   * Only populated for idle_update_score jobs from AutoUpdateScheduler.
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

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type JobDocument = HydratedDocument<JobEntity>;
export const JobSchema = SchemaFactory.createForClass(JobEntity);

// 7 天 TTL 索引，自动清理过期 job
JobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
