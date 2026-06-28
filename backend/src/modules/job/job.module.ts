import { JobEntity, JobSchema } from './schemas/job.schema';
import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BotsModule } from '../bots/bots.module';
import { JobFriendshipService } from './services/job-friendship.service';
import { JobApiLogService } from './api-log/api-log.service';
import { JobQueueService } from './services/job-queue.service';
import { JobService } from './services/job.service';
import { JobTempCacheService } from './cache/temp-cache.service';
import { MongooseModule } from '@nestjs/mongoose';
import { ProberExportModule } from '../prober-export/prober-export.module';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: JobEntity.name, schema: JobSchema }]),
    SdgbWorkerModule,
    ProberExportModule,
    BotsModule,
    forwardRef(() => SyncModule),
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
  ],
  providers: [
    JobService,
    JobFriendshipService,
    JobQueueService,
    JobTempCacheService,
    JobApiLogService,
  ],
  exports: [
    JobService,
    JobFriendshipService,
    JobQueueService,
    JobTempCacheService,
    JobApiLogService,
  ],
})
export class JobModule {}
