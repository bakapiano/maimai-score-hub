import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UserEntity, UserSchema } from '../users/schemas/user.schema';
import {
  StatsCardShare,
  StatsCardShareSchema,
  StatsCardArtifact,
  StatsCardArtifactSchema,
} from './stats-card.schemas';
import { StatsCardService } from './stats-card.service';
import { StatsCardRenderer } from './stats-card.renderer';
import { StatsCardAssets } from './stats-card.assets';
import { StatsCardRateLimit } from './stats-card.http';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: StatsCardShare.name, schema: StatsCardShareSchema },
      { name: StatsCardArtifact.name, schema: StatsCardArtifactSchema },
    ]),
  ],
  providers: [
    StatsCardService,
    StatsCardRenderer,
    StatsCardAssets,
    StatsCardRateLimit,
  ],
  exports: [StatsCardService, StatsCardRateLimit],
})
export class StatsCardModule {}
