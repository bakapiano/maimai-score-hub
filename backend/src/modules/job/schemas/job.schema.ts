import type { JobStage, JobStatus, JobType, ScoreProgress } from '../job.types';
import type {
  CabinetFriendshipStatus,
  DxnetJobErrorCode,
  DxnetJobRouting,
  ScoreFetchTarget,
} from '@maimai-score-hub/shared';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import type { UserNetProfile } from '../../users/user.types';

@Schema({ collection: 'jobs' })
export class JobEntity {
  @Prop({ required: true, unique: true, index: true })
  id!: string;

  @Prop({ required: false, type: String, default: null })
  friendCode!: string | null;

  @Prop({ required: true, type: String, default: 'send_friend_request' })
  jobType!: JobType;

  @Prop({ required: true, type: Number, min: 0, max: 4, default: 0 })
  priority!: number;

  /** Required for all newly created jobs; nullable only on pre-cutover rows. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  routing!: DxnetJobRouting | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  execution!: {
    deliveryEpoch: number;
    attemptsStarted: number;
    workerId: string;
    startedAt: Date;
  } | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  cabinetFriendship!: {
    status: CabinetFriendshipStatus;
    botFriendCode: string | null;
    deliveryEpoch: number | null;
    attemptsStarted: number | null;
    sdgbJobId: string | null;
    lastError: string | null;
  } | null;

  @Prop({ type: Date, default: null })
  deadlineAt!: Date | null;

  @Prop({ type: String, default: null })
  errorCode!: DxnetJobErrorCode | null;

  @Prop({ type: Boolean, default: false })
  completionPending!: boolean;

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

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  scoreProgress!: ScoreProgress | null;

  @Prop({ type: Number, default: null })
  updateScoreDuration!: number | null;

  @Prop({ type: [Number], default: null })
  diffsToScrape!: number[] | null;

  @Prop({ type: [String], default: null })
  musicIds!: string[] | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  scoreFetchTargets!: ScoreFetchTarget[] | null;

  @Prop({ type: Boolean, default: false })
  fcfsOnly!: boolean;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  context!: Record<string, unknown> | null;

  /**
   * Next time this job may be delivered by BullMQ. Null means immediately
   * dispatchable. Used for waiting/cooldown stages so updatedAt stays a real
   * audit field.
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

// Hot-path indexes for active job lookups and per-bot load aggregation.
JobSchema.index({ botUserFriendCode: 1, status: 1 }, { name: 'bot_status' });
JobSchema.index(
  { jobType: 1, friendCode: 1, createdAt: -1 },
  { name: 'latest_by_type_friend' },
);
JobSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'status_createdAt_desc' },
);
JobSchema.index({ status: 1, jobType: 1 }, { name: 'status_jobType' });
JobSchema.index({ status: 1, updatedAt: -1 }, { name: 'status_updatedAt' });
JobSchema.index(
  { 'context.source': 1, 'context.dailyTaskId': 1, createdAt: -1 },
  { name: 'daily_full_update_lookup' },
);
JobSchema.index(
  { 'context.source': 1, 'context.fcfsTaskId': 1, createdAt: -1 },
  { name: 'fcfs_update_lookup' },
);
JobSchema.index(
  { 'context.source': 1, 'context.settledTaskId': 1, createdAt: -1 },
  { name: 'settled_full_update_lookup' },
);
JobSchema.index(
  { 'routing.version': 1, status: 1, deadlineAt: 1 },
  { name: 'routing_status_deadline' },
);
JobSchema.index(
  { 'routing.version': 1, 'routing.lane': 1, status: 1 },
  { name: 'routing_lane_status' },
);
