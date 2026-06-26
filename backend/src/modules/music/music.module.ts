import { MusicEntity, MusicSchema } from './schemas/music.schema';
import {
  MusicConfigEntity,
  MusicConfigSchema,
} from './schemas/music-config.schema';

import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicService } from './services/music.service';

@Module({
  imports: [
    CacheModule.register(),
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
      { name: MusicConfigEntity.name, schema: MusicConfigSchema },
    ]),
  ],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
