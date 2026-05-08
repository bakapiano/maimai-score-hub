import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SdgbJobController } from './sdgb-job.controller';
import { SdgbJobDispatcher } from './sdgb-job.dispatcher';
import { SdgbJobEntity, SdgbJobSchema } from './sdgb-job.schema';
import { SdgbJobService } from './sdgb-job.service';
import {
  SdgbWorkerStatusEntity,
  SdgbWorkerStatusSchema,
} from './sdgb-worker-status.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SdgbJobEntity.name, schema: SdgbJobSchema },
      { name: SdgbWorkerStatusEntity.name, schema: SdgbWorkerStatusSchema },
    ]),
  ],
  controllers: [SdgbJobController],
  providers: [SdgbJobService, SdgbJobDispatcher],
  exports: [SdgbJobService, SdgbJobDispatcher],
})
export class SdgbWorkerModule {}
