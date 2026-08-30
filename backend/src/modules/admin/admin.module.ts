import { JobEntity, JobSchema } from '../job/schemas/job.schema';
import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';
import { SyncEntity, SyncSchema } from '../sync/schemas/sync.schema';
import { UserEntity, UserSchema } from '../users/schemas/user.schema';
import { AdminCatalogService } from './services/admin-catalog.service';
import { AdminJobMetricsService } from './services/admin-job-metrics.service';
import { AdminJobQueryService } from './services/admin-job-query.service';
import { AdminSummaryService } from './services/admin-summary.service';
import { AdminUsersService } from './services/admin-users.service';
import {
  BotStatusEntity,
  BotStatusSchema,
} from '../bots/schemas/bot-status.schema';
import { CatalogModule } from '../catalog/catalog.module';
import { CoverModule } from '../cover/cover.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JobModule } from '../job/job.module';
import { MusicAliasModule } from '../music-alias/music-alias.module';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: MusicEntity.name, schema: MusicSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: JobEntity.name, schema: JobSchema },
      { name: BotStatusEntity.name, schema: BotStatusSchema },
    ]),
    CatalogModule,
    CoverModule,
    JobModule,
    MusicAliasModule,
    SdgbWorkerModule,
    UsersModule,
  ],
  providers: [
    AdminCatalogService,
    AdminJobMetricsService,
    AdminJobQueryService,
    AdminSummaryService,
    AdminUsersService,
  ],
  exports: [
    AdminCatalogService,
    AdminJobMetricsService,
    AdminJobQueryService,
    AdminSummaryService,
    AdminUsersService,
  ],
})
export class AdminModule {}
