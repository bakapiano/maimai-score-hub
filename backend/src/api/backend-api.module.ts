import { Module } from '@nestjs/common';

import { AdminBotsController } from './admin/admin-bots.controller';
import { AdminAndroidAppReleaseController } from './admin/admin-android-app-release.controller';
import { AdminCatalogController } from './admin/admin-catalog.controller';
import { AdminDashboardController } from './admin/admin-dashboard.controller';
import { AdminDxnetJobsController } from './admin/admin-dxnet-jobs.controller';
import { AdminDxnetRoutingControlController } from './admin/admin-dxnet-routing-control.controller';
import { AdminObservabilityController } from './admin/admin-observability.controller';
import { SharedSecretGuard } from '../common/guards/shared-secret.guard';
import { AdminModule } from '../modules/admin/admin.module';
import { AdminUsersController } from './admin/admin-users.controller';
import { AndroidWorkflowController } from './public/android-workflow.controller';
import { AndroidWorkflowModule } from '../modules/android-workflow/android-workflow.module';
import { AndroidAppReleaseController } from './public/android-app-release.controller';
import { AndroidAppReleaseModule } from '../modules/android-app-release/android-app-release.module';
import { AuthController } from './auth/auth.controller';
import { PasskeyAuthController } from './auth/passkey-auth.controller';
import { AuthModule } from '../modules/auth/auth.module';
import { AutoUpdateModule } from '../modules/auto-update/auto-update.module';
import { BotsModule } from '../modules/bots/bots.module';
import { CabinetScoreSyncModule } from '../modules/cabinet-score-sync/cabinet-score-sync.module';
import { CatalogModule } from '../modules/catalog/catalog.module';
import { CoverCatalogController } from './catalog/cover-catalog.controller';
import { CoverModule } from '../modules/cover/cover.module';
import { JobModule } from '../modules/job/job.module';
import { MeController } from './me/me.controller';
import { MePasskeysController } from './me/me-passkeys.controller';
import { MeCabinetScoreJobsController } from './me/me-cabinet-score-jobs.controller';
import { MeDxnetJobsController } from './me/me-dxnet-jobs.controller';
import { MeScoreExportController } from './me/me-score-export.controller';
import { MeScoreChangesController } from './me/me-score-changes.controller';
import { MeScoreHistoryController } from './me/me-score-history.controller';
import { MeSyncController } from './me/me-sync.controller';
import { MusicCatalogController } from './catalog/music-catalog.controller';
import { MusicModule } from '../modules/music/music.module';
import { ObservabilityController } from './observability/observability.controller';
import { ObservabilityModule } from '../modules/observability/observability.module';
import { OcrModule } from '../modules/ocr/ocr.module';
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
import { WorkerSdgbControlController } from './workers/worker-sdgb-control.controller';
import { WorkerSdgbMaintenanceController } from './workers/worker-sdgb-maintenance.controller';
import { APP_FILTER } from '@nestjs/core';
import { DxnetBotAssignmentBusyFilter } from '../modules/job/dxnet-job.exceptions';

@Module({
  imports: [
    AdminModule,
    AndroidAppReleaseModule,
    AndroidWorkflowModule,
    AuthModule,
    AutoUpdateModule,
    BotsModule,
    CabinetScoreSyncModule,
    CatalogModule,
    CoverModule,
    JobModule,
    MusicModule,
    ObservabilityModule,
    OcrModule,
    ProberExportModule,
    ScoreExportModule,
    SdgbWorkerModule,
    SyncModule,
    UsersModule,
  ],
  controllers: [
    AuthController,
    AndroidAppReleaseController,
    AndroidWorkflowController,
    PasskeyAuthController,
    MeController,
    MePasskeysController,
    MeCabinetScoreJobsController,
    MeDxnetJobsController,
    MeScoreExportController,
    MeScoreChangesController,
    MeScoreHistoryController,
    MeSyncController,
    MusicCatalogController,
    CoverCatalogController,
    ObservabilityController,
    PublicStatisticsController,
    AdminBotsController,
    AdminAndroidAppReleaseController,
    AdminCatalogController,
    AdminDashboardController,
    AdminDxnetJobsController,
    AdminDxnetRoutingControlController,
    AdminObservabilityController,
    AdminUsersController,
    WorkerBotStatusController,
    WorkerDxnetApiCallsController,
    WorkerDxnetJobsController,
    WorkerDxnetTempCacheController,
    WorkerExternalApiCallsController,
    WorkerLogIngestController,
    WorkerSdgbJobsController,
    WorkerSdgbControlController,
    WorkerSdgbMaintenanceController,
  ],
  providers: [
    SharedSecretGuard,
    { provide: APP_FILTER, useClass: DxnetBotAssignmentBusyFilter },
  ],
})
export class BackendApiModule {}
