import { MusicEntity, MusicSchema } from '../music/music.schema';

import { CoverController } from './cover.controller';
import { CoverService } from './cover.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicModule } from '../music/music.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
    MusicModule,
  ],
  controllers: [CoverController],
  providers: [CoverService],
  exports: [CoverService],
})
export class CoverModule {}
