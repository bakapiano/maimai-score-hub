import { JobEntity, JobSchema } from '../job/job.schema';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { SyncEntity, SyncSchema } from '../sync/sync.schema';
import { UserEntity, UserSchema } from '../users/user.schema';

import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { CoverModule } from '../cover/cover.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicModule } from '../music/music.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: MusicEntity.name, schema: MusicSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: JobEntity.name, schema: JobSchema },
    ]),
    CoverModule,
    MusicModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
