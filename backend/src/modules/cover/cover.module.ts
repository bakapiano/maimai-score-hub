import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';

import { CoverService } from './services/cover.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  providers: [CoverService],
  exports: [CoverService],
})
export class CoverModule {}
