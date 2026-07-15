import { Module } from '@nestjs/common';

import { CoverModule } from '../cover/cover.module';
import { MusicModule } from '../music/music.module';
import { CatalogSyncService } from './services/catalog-sync.service';

@Module({
  imports: [CoverModule, MusicModule],
  providers: [CatalogSyncService],
  exports: [CatalogSyncService],
})
export class CatalogModule {}
