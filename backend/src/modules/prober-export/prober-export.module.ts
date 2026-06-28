import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  ProberExportJobEntity,
  ProberExportJobSchema,
} from './schemas/prober-export-job.schema';
import { ProberExportService } from './services/prober-export.service';
import { ProberExportWorkerService } from './services/prober-export-worker.service';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    forwardRef(() => SyncModule),
    forwardRef(() => UsersModule),
    MongooseModule.forFeature([
      { name: ProberExportJobEntity.name, schema: ProberExportJobSchema },
    ]),
  ],
  providers: [ProberExportService, ProberExportWorkerService],
  exports: [ProberExportService],
})
export class ProberExportModule {}
