import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  SystemSettingsEntity,
  SystemSettingsSchema,
} from './system-settings.schema';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SystemSettingsEntity.name, schema: SystemSettingsSchema },
    ]),
  ],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
