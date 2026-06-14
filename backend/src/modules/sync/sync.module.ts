import { Module, forwardRef } from '@nestjs/common';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { SyncEntity, SyncSchema } from './sync.schema';

import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { UsersModule } from '../users/users.module';
import { MusicModule } from '../music/music.module';
import { ProberExportMapService } from './prober-export-map.service';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    MusicModule,
    MongooseModule.forFeature([
      { name: SyncEntity.name, schema: SyncSchema },
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  controllers: [SyncController],
  providers: [SyncService, ProberExportMapService],
  exports: [SyncService],
})
export class SyncModule {}
