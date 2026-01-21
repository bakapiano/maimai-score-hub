import type { JobStage, JobStatus, ScoreProgress } from './job.types';
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

  @Prop({ required: true, default: false })
  skipUpdateScore!: boolean;

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

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type JobDocument = HydratedDocument<JobEntity>;
export const JobSchema = SchemaFactory.createForClass(JobEntity);
