import { JobApiLogEntity, JobApiLogSchema } from './job-api-log.schema';
import { JobEntity, JobSchema } from './job.schema';
import {
  JobTempCacheEntity,
  JobTempCacheSchema,
} from './job-temp-cache.schema';
import {
  IdleUpdateLogEntity,
  IdleUpdateLogSchema,
} from './idle-update-log.schema';
import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdleUpdateLogService } from './idle-update-log.service';
import { IdleUpdateSchedulerService } from './idle-update-scheduler.service';
import { JobApiLogService } from './job-api-log.service';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { JobTempCacheService } from './job-temp-cache.service';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: JobTempCacheEntity.name, schema: JobTempCacheSchema },
      { name: JobApiLogEntity.name, schema: JobApiLogSchema },
      { name: IdleUpdateLogEntity.name, schema: IdleUpdateLogSchema },
    ]),
    forwardRef(() => SyncModule),
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
  ],
  controllers: [JobController],
  providers: [
    JobService,
    JobTempCacheService,
    JobApiLogService,
    IdleUpdateLogService,
    IdleUpdateSchedulerService,
  ],
  exports: [
    JobService,
    JobTempCacheService,
    JobApiLogService,
    IdleUpdateLogService,
    IdleUpdateSchedulerService,
  ],
})
export class JobModule {}
