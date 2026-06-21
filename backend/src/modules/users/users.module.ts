import { Module, forwardRef } from '@nestjs/common';
import { UserEntity, UserSchema } from './user.schema';

import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { MeController } from './me.controller';
import { UsersService } from './users.service';
import { JobModule } from '../job/job.module';
import { AdminModule } from '../admin/admin.module';
import { CabinetService } from './cabinet.service';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncEntity, SyncSchema } from '../sync/sync.schema';
import { JobEntity, JobSchema } from '../job/job.schema';
import { AccountDeletionService } from './account-deletion.service';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => JobModule),
    forwardRef(() => AdminModule),
    SdgbWorkerModule,
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: JobEntity.name, schema: JobSchema },
    ]),
  ],
  controllers: [MeController],
  providers: [UsersService, CabinetService, AccountDeletionService],
  exports: [UsersService, CabinetService],
})
export class UsersModule {}
