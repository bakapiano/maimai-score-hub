import { Injectable } from '@nestjs/common';

import { CatalogSyncService } from '../../catalog/services/catalog-sync.service';

@Injectable()
export class AdminCatalogService {
  constructor(private readonly catalogSync: CatalogSyncService) {}

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
}
