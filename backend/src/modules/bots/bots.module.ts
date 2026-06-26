import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  BotFriendSnapshotEntity,
  BotFriendSnapshotSchema,
} from './schemas/bot-friend-snapshot.schema';
import { BotFriendSnapshotService } from './services/bot-friend-snapshot.service';
import { BotStatusEntity, BotStatusSchema } from './schemas/bot-status.schema';
import { BotStatusService } from './services/bot-status.service';
import { FeishuNotifyService } from './services/feishu-notify.service';
import { JobEntity, JobSchema } from '../job/schemas/job.schema';
import {
  NotifyStateEntity,
  NotifyStateSchema,
} from './schemas/notify-state.schema';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { UserEntity, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: UserEntity.name, schema: UserSchema },
      { name: BotStatusEntity.name, schema: BotStatusSchema },
      {
        name: BotFriendSnapshotEntity.name,
        schema: BotFriendSnapshotSchema,
      },
      { name: NotifyStateEntity.name, schema: NotifyStateSchema },
    ]),
    SdgbWorkerModule,
    forwardRef(() => UsersModule),
  ],
  providers: [BotStatusService, BotFriendSnapshotService, FeishuNotifyService],
  exports: [BotStatusService, BotFriendSnapshotService],
})
export class BotsModule {}
