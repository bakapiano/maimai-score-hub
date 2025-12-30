import type { JobStage, JobStatus } from './job.types';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

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

  @Prop({ required: true })
  status!: JobStatus;

  @Prop({ required: true })
  stage!: JobStage;

  @Prop({ type: MongooseSchema.Types.Mixed, default: undefined })
  result?: any;

  @Prop({ type: String, default: null })
  error!: string | null;

  @Prop({ required: true, default: false })
  executing!: boolean;

  @Prop({ required: true, default: 0 })
  retryCount!: number;

  @Prop({ type: Date, default: null })
  nextRetryAt!: Date | null;

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type JobDocument = HydratedDocument<JobEntity>;
export const JobSchema = SchemaFactory.createForClass(JobEntity);
