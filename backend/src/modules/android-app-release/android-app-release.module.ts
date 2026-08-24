import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  AndroidAppReleasePolicyEntity,
  AndroidAppReleasePolicySchema,
} from './schemas/android-app-release-policy.schema';
import {
  AndroidAppReleaseEntity,
  AndroidAppReleaseSchema,
} from './schemas/android-app-release.schema';
import { AndroidAppReleaseService } from './services/android-app-release.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: AndroidAppReleaseEntity.name,
        schema: AndroidAppReleaseSchema,
      },
      {
        name: AndroidAppReleasePolicyEntity.name,
        schema: AndroidAppReleasePolicySchema,
      },
    ]),
  ],
  providers: [AndroidAppReleaseService],
  exports: [AndroidAppReleaseService],
})
export class AndroidAppReleaseModule {}
