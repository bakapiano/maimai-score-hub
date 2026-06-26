import { Module, forwardRef } from '@nestjs/common';
import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';
import { SyncEntity, SyncSchema } from '../sync/schemas/sync.schema';

import { AuthModule } from '../auth/auth.module';
import { CoverModule } from '../cover/cover.module';
import { UsersModule } from '../users/users.module';
import { MongooseModule } from '@nestjs/mongoose';
import { ScoreExportService } from './services/score-export.service';

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
  providers: [ScoreExportService],
  exports: [ScoreExportService],
})
export class ScoreExportModule {}
