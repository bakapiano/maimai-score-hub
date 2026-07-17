import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SdgbJobDispatcher } from './services/sdgb-job.dispatcher';
import { SdgbJobEntity, SdgbJobSchema } from './schemas/sdgb-job.schema';
import {
  SdgbMaintenanceRunEntity,
  SdgbMaintenanceRunSchema,
} from './schemas/sdgb-maintenance-run.schema';
import { SdgbJobService } from './services/sdgb-job.service';
import { SdgbQueueRepairService } from './services/sdgb-queue-repair.service';
import { SdgbWorkerRegistryService } from './services/sdgb-worker-registry.service';
import { SdgbWorkerIncidentService } from './services/sdgb-worker-incident.service';
import { SdgbMaintenanceService } from './services/sdgb-maintenance.service';
import { SdgbJobAdminQueryService } from './services/sdgb-job-admin-query.service';
import { SdgbProbeBacklogMonitorService } from './services/sdgb-probe-backlog-monitor.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SdgbJobEntity.name, schema: SdgbJobSchema },
      {
        name: SdgbMaintenanceRunEntity.name,
        schema: SdgbMaintenanceRunSchema,
      },
    ]),
  ],
  providers: [
    SdgbJobService,
    SdgbJobDispatcher,
    SdgbQueueRepairService,
    SdgbWorkerRegistryService,
    SdgbWorkerIncidentService,
    SdgbMaintenanceService,
    SdgbJobAdminQueryService,
    SdgbProbeBacklogMonitorService,
  ],
  exports: [
    SdgbJobService,
    SdgbJobDispatcher,
    SdgbWorkerRegistryService,
    SdgbWorkerIncidentService,
    SdgbMaintenanceService,
  ],
})
export class SdgbWorkerModule {}
