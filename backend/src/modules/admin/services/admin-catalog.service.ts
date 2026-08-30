import { Injectable } from '@nestjs/common';

import { CatalogSyncService } from '../../catalog/services/catalog-sync.service';
import { MusicAliasSyncService } from '../../music-alias/services/music-alias-sync.service';

@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly catalogSync: CatalogSyncService,
    private readonly aliasSync: MusicAliasSyncService,
  ) {}

  async syncCovers() {
    return this.catalogSync.syncCovers(false);
  }

  async forceSyncCovers() {
    return this.catalogSync.syncCovers(true);
  }

  async backfillCoverVariants() {
    return this.catalogSync.backfillCoverVariants();
  }

  async syncMusic() {
    return this.catalogSync.syncMusic();
  }

  async syncAliases() {
    return this.aliasSync.syncNow();
  }
}
