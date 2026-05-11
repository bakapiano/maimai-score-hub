import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdminModule } from '../admin/admin.module';
import { JobModule } from '../job/job.module';
import { JobEntity, JobSchema } from '../job/job.schema';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SdgbJobEntity, SdgbJobSchema } from '../sdgb-worker/sdgb-job.schema';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';
import { AutoUpdateController } from './auto-update.controller';
import {
  AutoUpdateRunEntity,
  AutoUpdateRunSchema,
} from './auto-update-run.schema';
import { AutoUpdateSchedulerService } from './auto-update-scheduler.service';

@Module({
  imports: [
    UsersModule,
    JobModule,
    AdminModule,
    SdgbWorkerModule,
    SyncModule,
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: SdgbJobEntity.name, schema: SdgbJobSchema },
      { name: AutoUpdateRunEntity.name, schema: AutoUpdateRunSchema },
    ]),
  ],
  controllers: [AutoUpdateController],
  providers: [AutoUpdateSchedulerService],
})
export class AutoUpdateModule {}
