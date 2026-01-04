import { JobEntity, JobSchema } from './job.schema';
import { Module, forwardRef } from '@nestjs/common';

import { JobController } from './job.controller';
import { JobService } from './job.service';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: JobEntity.name, schema: JobSchema }]),
    forwardRef(() => SyncModule),
  ],
  controllers: [JobController],
  providers: [JobService],
  exports: [JobService],
})
export class JobModule {}
