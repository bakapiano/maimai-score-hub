import { MusicEntity, MusicSchema } from './music.schema';

import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicController } from './music.controller';
import { MusicService } from './music.service';

@Module({
  imports: [
    CacheModule.register(),
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  controllers: [MusicController],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
