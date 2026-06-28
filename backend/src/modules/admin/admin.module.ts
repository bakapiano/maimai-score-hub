import { JobEntity, JobSchema } from '../job/schemas/job.schema';
import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';
import { SyncEntity, SyncSchema } from '../sync/schemas/sync.schema';
import { UserEntity, UserSchema } from '../users/schemas/user.schema';
import {
  AutoUpdateRunEntity,
  AutoUpdateRunSchema,
} from '../auto-update/schemas/auto-update-run.schema';

import { AdminAutoUpdateMetricsService } from './services/admin-auto-update-metrics.service';
import { AdminCatalogService } from './services/admin-catalog.service';
import { AdminJobMetricsService } from './services/admin-job-metrics.service';
import { AdminJobQueryService } from './services/admin-job-query.service';
import { AdminProberExportMetricsService } from './services/admin-prober-export-metrics.service';
import { AdminSummaryService } from './services/admin-summary.service';
import { AdminUsersService } from './services/admin-users.service';
import {
  BotStatusEntity,
  BotStatusSchema,
} from '../bots/schemas/bot-status.schema';
import { CoverModule } from '../cover/cover.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicModule } from '../music/music.module';
import { JobModule } from '../job/job.module';
import {
  ProberExportJobEntity,
  ProberExportJobSchema,
} from '../prober-export/schemas/prober-export-job.schema';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: MusicEntity.name, schema: MusicSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: JobEntity.name, schema: JobSchema },
      { name: ProberExportJobEntity.name, schema: ProberExportJobSchema },
      { name: BotStatusEntity.name, schema: BotStatusSchema },
      { name: AutoUpdateRunEntity.name, schema: AutoUpdateRunSchema },
    ]),
    CoverModule,
    MusicModule,
    JobModule,
    SdgbWorkerModule,
    UsersModule,
  ],
  providers: [
    AdminAutoUpdateMetricsService,
    AdminCatalogService,
    AdminJobMetricsService,
    AdminJobQueryService,
    AdminProberExportMetricsService,
    AdminSummaryService,
    AdminUsersService,
  ],
  exports: [
    AdminAutoUpdateMetricsService,
    AdminCatalogService,
    AdminJobMetricsService,
    AdminJobQueryService,
    AdminProberExportMetricsService,
    AdminSummaryService,
    AdminUsersService,
  ],
})
export class AdminModule {}
