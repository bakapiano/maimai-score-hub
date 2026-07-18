import { Module, forwardRef } from '@nestjs/common';
import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';
import { SyncEntity, SyncSchema } from './schemas/sync.schema';
import {
  ScoreChangeEntity,
  ScoreChangeSchema,
} from './schemas/score-change.schema';

import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncService } from './services/sync.service';
import { UsersModule } from '../users/users.module';
import { ProberExportMapService } from './services/prober-export-map.service';
import { ScoreChangeHistoryService } from './services/score-change-history.service';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    MongooseModule.forFeature([
      { name: SyncEntity.name, schema: SyncSchema },
      { name: ScoreChangeEntity.name, schema: ScoreChangeSchema },
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  providers: [SyncService, ProberExportMapService, ScoreChangeHistoryService],
  exports: [SyncService, ScoreChangeHistoryService],
})
export class SyncModule {}
