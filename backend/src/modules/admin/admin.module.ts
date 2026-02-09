import { JobEntity, JobSchema } from '../job/job.schema';
import {
  JobApiLogEntity,
  JobApiLogSchema,
} from '../job/job-api-log.schema';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { SyncEntity, SyncSchema } from '../sync/sync.schema';
import { UserEntity, UserSchema } from '../users/user.schema';

import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { BotStatusService } from './bot-status.service';
import { CoverModule } from '../cover/cover.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicModule } from '../music/music.module';
import { JobModule } from '../job/job.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: MusicEntity.name, schema: MusicSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: JobEntity.name, schema: JobSchema },
      { name: JobApiLogEntity.name, schema: JobApiLogSchema },
    ]),
    CoverModule,
    MusicModule,
    JobModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, BotStatusService],
})
export class AdminModule {}
