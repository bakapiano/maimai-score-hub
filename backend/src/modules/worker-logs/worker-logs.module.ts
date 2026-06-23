import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import {
  AdminWorkerLogsController,
  WorkerLogIngestController,
} from './worker-logs.controller';
import { WorkerLogsService } from './worker-logs.service';

@Module({
  imports: [AdminModule],
  controllers: [WorkerLogIngestController, AdminWorkerLogsController],
  providers: [WorkerLogsService],
  exports: [WorkerLogsService],
})
export class WorkerLogsModule {}
