import { Module, forwardRef } from '@nestjs/common';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { SyncEntity, SyncSchema } from '../sync/sync.schema';

import { AuthModule } from '../auth/auth.module';
import { CoverModule } from '../cover/cover.module';
import { UsersModule } from '../users/users.module';
import { MongooseModule } from '@nestjs/mongoose';
import { ScoreExportController } from './score-export.controller';
import { ScoreExportService } from './score-export.service';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    CoverModule,
    forwardRef(() => UsersModule),
    MongooseModule.forFeature([
      { name: SyncEntity.name, schema: SyncSchema },
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  controllers: [ScoreExportController],
  providers: [ScoreExportService],
  exports: [ScoreExportService],
})
export class ScoreExportModule {}
