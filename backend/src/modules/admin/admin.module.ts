import { JobEntity, JobSchema } from '../job/job.schema';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { SyncEntity, SyncSchema } from '../sync/sync.schema';
import { UserEntity, UserSchema } from '../users/user.schema';
import {
  AutoUpdateRunEntity,
  AutoUpdateRunSchema,
} from '../auto-update/auto-update-run.schema';

import { AdminBotsController } from './admin-bots.controller';
import { AdminCatalogController } from './admin-catalog.controller';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDxnetJobsController } from './admin-dxnet-jobs.controller';
import { AdminGuard } from './admin.guard';
import { AdminSdgbController } from './admin-sdgb.controller';
import { AdminService } from './admin.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminUsersController } from './admin-users.controller';
import {
  BotFriendSnapshotEntity,
  BotFriendSnapshotSchema,
} from './bot-friend-snapshot.schema';
import { BotFriendSnapshotService } from './bot-friend-snapshot.service';
import { BotStatusEntity, BotStatusSchema } from './bot-status.schema';
import { BotStatusService } from './bot-status.service';
import { CoverModule } from '../cover/cover.module';
import { FeishuNotifyService } from './feishu-notify.service';
import { Module } from '@nestjs/common';
import { NotifyStateEntity, NotifyStateSchema } from './notify-state.schema';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicModule } from '../music/music.module';
import { JobModule } from '../job/job.module';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { UsersModule } from '../users/users.module';
import { SystemSettingsModule } from './system-settings.module';
import { WorkerBotStatusController } from './worker-bot-status.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: MusicEntity.name, schema: MusicSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: JobEntity.name, schema: JobSchema },
      { name: BotStatusEntity.name, schema: BotStatusSchema },
      {
        name: BotFriendSnapshotEntity.name,
        schema: BotFriendSnapshotSchema,
      },
      { name: NotifyStateEntity.name, schema: NotifyStateSchema },
      { name: AutoUpdateRunEntity.name, schema: AutoUpdateRunSchema },
    ]),
    CoverModule,
    MusicModule,
    JobModule,
    SdgbWorkerModule,
    UsersModule,
    SystemSettingsModule,
  ],
  controllers: [
    AdminBotsController,
    AdminCatalogController,
    AdminDashboardController,
    AdminDxnetJobsController,
    AdminSdgbController,
    AdminSettingsController,
    AdminUsersController,
    WorkerBotStatusController,
  ],
  providers: [
    AdminService,
    AdminGuard,
    BotStatusService,
    BotFriendSnapshotService,
    FeishuNotifyService,
  ],
  exports: [
    BotStatusService,
    BotFriendSnapshotService,
    AdminGuard,
    SystemSettingsModule,
  ],
})
export class AdminModule {}
