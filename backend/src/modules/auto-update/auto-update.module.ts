import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BotsModule } from '../bots/bots.module';
import { JobModule } from '../job/job.module';
import { JobEntity, JobSchema } from '../job/schemas/job.schema';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';
import {
  AutoUpdateRunEntity,
  AutoUpdateRunSchema,
} from './schemas/auto-update-run.schema';
import { AutoUpdateSchedulerService } from './services/auto-update-scheduler.service';

@Module({
  imports: [
    UsersModule,
    JobModule,
    BotsModule,
    SdgbWorkerModule,
    SyncModule,
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: AutoUpdateRunEntity.name, schema: AutoUpdateRunSchema },
    ]),
  ],
  providers: [AutoUpdateSchedulerService],
  exports: [AutoUpdateSchedulerService],
})
export class AutoUpdateModule {}
