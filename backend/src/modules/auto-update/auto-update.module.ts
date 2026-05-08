import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { JobModule } from '../job/job.module';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { UsersModule } from '../users/users.module';
import { AutoUpdateController } from './auto-update.controller';
import { AutoUpdateSchedulerService } from './auto-update-scheduler.service';

@Module({
  imports: [UsersModule, JobModule, AdminModule, SdgbWorkerModule],
  controllers: [AutoUpdateController],
  providers: [AutoUpdateSchedulerService],
})
export class AutoUpdateModule {}
