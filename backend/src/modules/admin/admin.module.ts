import { JobEntity, JobSchema } from '../job/job.schema';
import { JobApiLogEntity, JobApiLogSchema } from '../job/api-log/api-log.schema';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { SyncEntity, SyncSchema } from '../sync/sync.schema';
import { UserEntity, UserSchema } from '../users/user.schema';
import {
  WorkerLogEntity,
  WorkerLogSchema,
} from '../worker-logs/worker-log.schema';
import {
  AutoUpdateRunEntity,
  AutoUpdateRunSchema,
} from '../auto-update/auto-update-run.schema';

import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: MusicEntity.name, schema: MusicSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: JobEntity.name, schema: JobSchema },
      { name: JobApiLogEntity.name, schema: JobApiLogSchema },
      { name: BotStatusEntity.name, schema: BotStatusSchema },
      {
        name: BotFriendSnapshotEntity.name,
        schema: BotFriendSnapshotSchema,
      },
      { name: NotifyStateEntity.name, schema: NotifyStateSchema },
      { name: WorkerLogEntity.name, schema: WorkerLogSchema },
      { name: AutoUpdateRunEntity.name, schema: AutoUpdateRunSchema },
    ]),
    CoverModule,
    MusicModule,
    JobModule,
    SdgbWorkerModule,
    UsersModule,
    SystemSettingsModule,
  ],
  controllers: [AdminController],
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
