import { JobEntity, JobSchema } from './schemas/job.schema';
import {
  DxnetRoutingControlEntity,
  DxnetRoutingControlSchema,
} from './schemas/dxnet-routing-control.schema';
import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AutoUpdateModule } from '../auto-update/auto-update.module';
import { BotsModule } from '../bots/bots.module';
import { JobFriendshipService } from './services/job-friendship.service';
import { JobQueueService } from './services/job-queue.service';
import { JobService } from './services/job.service';
import { DxnetRoutingControlService } from './services/dxnet-routing-control.service';
import { DxnetAssignmentMutexService } from './services/dxnet-assignment-mutex.service';
import { DxnetCabinetPreparationService } from './services/dxnet-cabinet-preparation.service';
import { JobTempCacheService } from './cache/temp-cache.service';
import { MongooseModule } from '@nestjs/mongoose';
import { ProberExportModule } from '../prober-export/prober-export.module';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';
import { MusicModule } from '../music/music.module';
import {
  QrLoginAttemptEntity,
  QrLoginAttemptSchema,
} from '../auth/schemas/qr-login-attempt.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      {
        name: DxnetRoutingControlEntity.name,
        schema: DxnetRoutingControlSchema,
      },
      { name: QrLoginAttemptEntity.name, schema: QrLoginAttemptSchema },
    ]),
    SdgbWorkerModule,
    ProberExportModule,
    BotsModule,
    forwardRef(() => SyncModule),
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    forwardRef(() => AutoUpdateModule),
    MusicModule,
  ],
  providers: [
    JobService,
    JobFriendshipService,
    JobQueueService,
    JobTempCacheService,
    DxnetRoutingControlService,
    DxnetAssignmentMutexService,
    DxnetCabinetPreparationService,
  ],
  exports: [
    JobService,
    JobFriendshipService,
    JobQueueService,
    JobTempCacheService,
    DxnetRoutingControlService,
    DxnetAssignmentMutexService,
    DxnetCabinetPreparationService,
  ],
})
export class JobModule {}
