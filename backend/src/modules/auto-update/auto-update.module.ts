import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BotsModule } from '../bots/bots.module';
import { JobModule } from '../job/job.module';
import { ProberExportModule } from '../prober-export/prober-export.module';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';
import {
  AutoUpdateProbeStateEntity,
  AutoUpdateProbeStateSchema,
} from './schemas/auto-update-probe-state.schema';
import {
  AutoUpdateRunEntity,
  AutoUpdateRunSchema,
} from './schemas/auto-update-run.schema';
import {
  AutoUpdateTaskEntity,
  AutoUpdateTaskSchema,
} from './schemas/auto-update-task.schema';
import { AutoUpdateSchedulerService } from './services/auto-update-scheduler.service';
import { AutoUpdateSchedulerTimingService } from './services/auto-update-scheduler-timing.service';

@Module({
  imports: [
    UsersModule,
    JobModule,
    ProberExportModule,
    BotsModule,
    SdgbWorkerModule,
    SyncModule,
    MongooseModule.forFeature([
      { name: AutoUpdateRunEntity.name, schema: AutoUpdateRunSchema },
      {
        name: AutoUpdateProbeStateEntity.name,
        schema: AutoUpdateProbeStateSchema,
      },
      { name: AutoUpdateTaskEntity.name, schema: AutoUpdateTaskSchema },
    ]),
  ],
  providers: [AutoUpdateSchedulerService, AutoUpdateSchedulerTimingService],
  exports: [AutoUpdateSchedulerService],
})
export class AutoUpdateModule {}
