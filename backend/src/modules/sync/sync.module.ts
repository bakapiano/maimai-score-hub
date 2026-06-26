import { Module, forwardRef } from '@nestjs/common';
import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';
import { SyncEntity, SyncSchema } from './schemas/sync.schema';

import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncService } from './services/sync.service';
import { UsersModule } from '../users/users.module';
import { ProberExportMapService } from './services/prober-export-map.service';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    MongooseModule.forFeature([
      { name: SyncEntity.name, schema: SyncSchema },
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  providers: [SyncService, ProberExportMapService],
  exports: [SyncService],
})
export class SyncModule {}
