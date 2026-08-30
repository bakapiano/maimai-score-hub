import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';
import {
  MusicAliasEntity,
  MusicAliasSchema,
} from './schemas/music-alias.schema';
import { MusicAliasSyncService } from './services/music-alias-sync.service';
import { MusicAliasService } from './services/music-alias.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MusicAliasEntity.name, schema: MusicAliasSchema },
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  providers: [MusicAliasService, MusicAliasSyncService],
  exports: [MusicAliasService, MusicAliasSyncService],
})
export class MusicAliasModule {}
