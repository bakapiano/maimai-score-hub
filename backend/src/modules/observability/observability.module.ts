import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';

import {
  BotStatusEntity,
  BotStatusSchema,
} from '../bots/schemas/bot-status.schema';
import { HttpObservabilityInterceptor } from './interceptors/http-observability.interceptor';
import { JobEntity, JobSchema } from '../job/schemas/job.schema';
import {
  ProberExportJobEntity,
  ProberExportJobSchema,
} from '../prober-export/schemas/prober-export-job.schema';
import {
  SdgbJobEntity,
  SdgbJobSchema,
} from '../sdgb-worker/schemas/sdgb-job.schema';
import { BackendLoggerService } from './services/backend-logger.service';
import { ClickHouseService } from './services/clickhouse.service';
import { ObservabilityIngestService } from './services/observability-ingest.service';
import { ObservabilityQueryService } from './services/observability-query.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: JobEntity.name, schema: JobSchema },
      { name: SdgbJobEntity.name, schema: SdgbJobSchema },
      { name: BotStatusEntity.name, schema: BotStatusSchema },
      { name: ProberExportJobEntity.name, schema: ProberExportJobSchema },
    ]),
  ],
  providers: [
    BackendLoggerService,
    ClickHouseService,
    ObservabilityIngestService,
    ObservabilityQueryService,
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpObservabilityInterceptor,
    },
  ],
  exports: [
    BackendLoggerService,
    ClickHouseService,
    ObservabilityIngestService,
    ObservabilityQueryService,
  ],
})
export class ObservabilityModule {}
