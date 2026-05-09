import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdminModule } from '../admin/admin.module';
import { WorkerLogEntity, WorkerLogSchema } from './worker-log.schema';
import { WorkerLogsController } from './worker-logs.controller';
import { WorkerLogsService } from './worker-logs.service';

@Module({
  imports: [
    AdminModule,
    MongooseModule.forFeature([
      { name: WorkerLogEntity.name, schema: WorkerLogSchema },
    ]),
  ],
  controllers: [WorkerLogsController],
  providers: [WorkerLogsService],
  exports: [WorkerLogsService],
})
export class WorkerLogsModule {}
