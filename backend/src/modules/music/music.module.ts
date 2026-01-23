import { MusicEntity, MusicSchema } from './music.schema';
import { MusicConfigEntity, MusicConfigSchema } from './music-config.schema';

import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicController } from './music.controller';
import { MusicService } from './music.service';
import { AdminGuard } from '../admin/admin.guard';

@Module({
  imports: [
    CacheModule.register(),
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
      { name: MusicConfigEntity.name, schema: MusicConfigSchema },
    ]),
  ],
  controllers: [MusicController],
  providers: [MusicService, AdminGuard],
  exports: [MusicService],
})
export class MusicModule {}
