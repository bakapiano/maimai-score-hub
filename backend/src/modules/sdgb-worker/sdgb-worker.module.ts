import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SdgbJobController } from './sdgb-job.controller';
import { SdgbJobDispatcher } from './sdgb-job.dispatcher';
import { SdgbJobEntity, SdgbJobSchema } from './sdgb-job.schema';
import { SdgbJobService } from './sdgb-job.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SdgbJobEntity.name, schema: SdgbJobSchema },
    ]),
  ],
  controllers: [SdgbJobController],
  providers: [SdgbJobService, SdgbJobDispatcher],
  exports: [SdgbJobService, SdgbJobDispatcher],
})
export class SdgbWorkerModule {}
