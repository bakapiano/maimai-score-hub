import { Module, forwardRef } from '@nestjs/common';
import { MusicEntity, MusicSchema } from '../music/music.schema';
import { SyncEntity, SyncSchema } from './sync.schema';

import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    MongooseModule.forFeature([
      { name: SyncEntity.name, schema: SyncSchema },
      { name: MusicEntity.name, schema: MusicSchema },
    ]),
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
