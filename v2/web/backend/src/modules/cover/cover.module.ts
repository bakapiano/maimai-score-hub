import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CoverController } from './cover.controller';
import { CoverService } from './cover.service';
import { MusicEntity, MusicSchema } from '../music/music.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  controllers: [CoverController],
  providers: [CoverService],
})
export class CoverModule {}
