import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SdgbJobDispatcher } from './services/sdgb-job.dispatcher';
import { SdgbJobEntity, SdgbJobSchema } from './schemas/sdgb-job.schema';
import { SdgbJobService } from './services/sdgb-job.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SdgbJobEntity.name, schema: SdgbJobSchema },
    ]),
  ],
  providers: [SdgbJobService, SdgbJobDispatcher],
  exports: [SdgbJobService, SdgbJobDispatcher],
})
export class SdgbWorkerModule {}
