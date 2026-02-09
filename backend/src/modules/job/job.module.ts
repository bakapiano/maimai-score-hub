import { JobEntity, JobSchema } from './job.schema';
import {
  JobTempCacheEntity,
  JobTempCacheSchema,
} from './job-temp-cache.schema';
import {
  JobApiLogEntity,
  JobApiLogSchema,
} from './job-api-log.schema';
import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { JobTempCacheService } from './job-temp-cache.service';
import { JobApiLogService } from './job-api-log.service';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: JobTempCacheEntity.name, schema: JobTempCacheSchema },
      { name: JobApiLogEntity.name, schema: JobApiLogSchema },
    ]),
    forwardRef(() => SyncModule),
    forwardRef(() => AuthModule),
  ],
  controllers: [JobController],
  providers: [JobService, JobTempCacheService, JobApiLogService],
  exports: [JobService, JobTempCacheService, JobApiLogService],
})
export class JobModule {}
