import { JobEntity, JobSchema } from './job.schema';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { Module, forwardRef } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { PublicDxnetJobsController } from './public-dxnet-jobs.controller';
import { UserDxnetJobsController } from './user-dxnet-jobs.controller';
import { WorkerDxnetApiLogController } from './api-log/api-log.controller';
import { WorkerDxnetJobsController } from './worker-dxnet-jobs.controller';
import { JobApiLogService } from './api-log/api-log.service';
import { JobService } from './job.service';
import { JobTempCacheService } from './cache/temp-cache.service';
import { WorkerDxnetTempCacheController } from './cache/temp-cache.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncModule } from '../sync/sync.module';
import { SystemSettingsModule } from '../admin/system-settings.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
    SdgbWorkerModule,
    SystemSettingsModule,
    forwardRef(() => SyncModule),
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    forwardRef(() => AdminModule),
  ],
  controllers: [
    PublicDxnetJobsController,
    UserDxnetJobsController,
    WorkerDxnetJobsController,
    WorkerDxnetTempCacheController,
    WorkerDxnetApiLogController,
  ],
  providers: [JobService, JobTempCacheService, JobApiLogService],
  exports: [JobService, JobTempCacheService, JobApiLogService],
})
export class JobModule {}
