import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BotFriendSnapshotService } from './services/bot-friend-snapshot.service';
import { BotStatusEntity, BotStatusSchema } from './schemas/bot-status.schema';
import { BotStatusService } from './services/bot-status.service';
import { JobEntity, JobSchema } from '../job/schemas/job.schema';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { UserEntity, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: UserEntity.name, schema: UserSchema },
      { name: BotStatusEntity.name, schema: BotStatusSchema },
    ]),
    SdgbWorkerModule,
    forwardRef(() => UsersModule),
  ],
  providers: [BotStatusService, BotFriendSnapshotService],
  exports: [BotStatusService, BotFriendSnapshotService],
})
export class BotsModule {}
