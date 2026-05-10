import { JobApiLogEntity, JobApiLogSchema } from './api-log/api-log.schema';
import { JobEntity, JobSchema } from './job.schema';
import {
  JobTempCacheEntity,
  JobTempCacheSchema,
} from './cache/temp-cache.schema';
import {
  IdleUpdateLogEntity,
  IdleUpdateLogSchema,
} from './idle-update/idle-update-log.schema';
import { Module, forwardRef } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { ApiLogController } from './api-log/api-log.controller';
import { IdleUpdateController } from './idle-update/idle-update.controller';
import { IdleUpdateLogService } from './idle-update/idle-update-log.service';
import { IdleUpdateSchedulerService } from './idle-update/idle-update-scheduler.service';
import { JobApiLogService } from './api-log/api-log.service';
import { JobController } from './job.controller';
import { JobService } from './job.service';
import { JobTempCacheService } from './cache/temp-cache.service';
import { TempCacheController } from './cache/temp-cache.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
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
    SdgbWorkerModule,
    forwardRef(() => SyncModule),
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    forwardRef(() => AdminModule),
  ],
  controllers: [
    JobController,
    TempCacheController,
    IdleUpdateController,
    ApiLogController,
  ],
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
