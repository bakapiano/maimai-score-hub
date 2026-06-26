import { Module } from '@nestjs/common';

import { WorkerLogsService } from './services/worker-logs.service';

@Module({
  providers: [WorkerLogsService],
  exports: [WorkerLogsService],
})
export class WorkerLogsModule {}
