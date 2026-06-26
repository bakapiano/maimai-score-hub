import { MusicEntity, MusicSchema } from './schemas/music.schema';

import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicService } from './services/music.service';

@Module({
  imports: [
    CacheModule.register(),
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
