import { JobEntity, JobSchema } from './job.schema';

import { JobController } from './job.controller';
import { JobService } from './job.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: JobEntity.name, schema: JobSchema }]),
  ],
  controllers: [JobController],
  providers: [JobService],
})
export class JobModule {}
