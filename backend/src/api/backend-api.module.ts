import { Module } from '@nestjs/common';

import { AdminBotsController } from './admin/admin-bots.controller';
import { AdminCatalogController } from './admin/admin-catalog.controller';
import { AdminDashboardController } from './admin/admin-dashboard.controller';
import { AdminDxnetJobsController } from './admin/admin-dxnet-jobs.controller';
import { AdminObservabilityController } from './admin/admin-observability.controller';
import { SharedSecretGuard } from '../common/guards/shared-secret.guard';
import { AdminModule } from '../modules/admin/admin.module';
import { AdminUsersController } from './admin/admin-users.controller';
import { AuthController } from './auth/auth.controller';
import { AuthModule } from '../modules/auth/auth.module';
import { AutoUpdateModule } from '../modules/auto-update/auto-update.module';
import { BotsModule } from '../modules/bots/bots.module';
import { CoverCatalogController } from './catalog/cover-catalog.controller';
import { CoverModule } from '../modules/cover/cover.module';
import { JobModule } from '../modules/job/job.module';
import { MeController } from './me/me.controller';
import { MeDxnetJobsController } from './me/me-dxnet-jobs.controller';
import { MeScoreExportController } from './me/me-score-export.controller';
import { MeSyncController } from './me/me-sync.controller';
import { MusicCatalogController } from './catalog/music-catalog.controller';
import { MusicModule } from '../modules/music/music.module';
import { ObservabilityController } from './observability/observability.controller';
import { ObservabilityModule } from '../modules/observability/observability.module';
import { PublicStatisticsController } from './public/public-statistics.controller';
import { ProberExportModule } from '../modules/prober-export/prober-export.module';
import { ScoreExportModule } from '../modules/score-export/score-export.module';
import { SdgbWorkerModule } from '../modules/sdgb-worker/sdgb-worker.module';
import { SyncModule } from '../modules/sync/sync.module';
import { UsersModule } from '../modules/users/users.module';
import { WorkerBotStatusController } from './workers/worker-bots.controller';
import { WorkerDxnetApiCallsController } from './workers/worker-dxnet-api-calls.controller';
import { WorkerDxnetJobsController } from './workers/worker-dxnet-jobs.controller';
import { WorkerDxnetTempCacheController } from './workers/worker-dxnet-temp-cache.controller';
import { WorkerExternalApiCallsController } from './workers/worker-external-api-calls.controller';
import { WorkerLogIngestController } from './workers/worker-logs.controller';
import { WorkerSdgbJobsController } from './workers/worker-sdgb-jobs.controller';

@Module({
  imports: [
    AdminModule,
    AuthModule,
    AutoUpdateModule,
    BotsModule,
    CoverModule,
    JobModule,
    MusicModule,
    ObservabilityModule,
    ProberExportModule,
    ScoreExportModule,
    SdgbWorkerModule,
    SyncModule,
    UsersModule,
  ],
  controllers: [
    AuthController,
    MeController,
    MeDxnetJobsController,
    MeScoreExportController,
    MeSyncController,
    MusicCatalogController,
    CoverCatalogController,
    ObservabilityController,
    PublicStatisticsController,
    AdminBotsController,
    AdminCatalogController,
    AdminDashboardController,
    AdminDxnetJobsController,
    AdminObservabilityController,
    AdminUsersController,
    WorkerBotStatusController,
    WorkerDxnetApiCallsController,
    WorkerDxnetJobsController,
    WorkerDxnetTempCacheController,
    WorkerExternalApiCallsController,
    WorkerLogIngestController,
    WorkerSdgbJobsController,
  ],
  providers: [SharedSecretGuard],
})
export class BackendApiModule {}
