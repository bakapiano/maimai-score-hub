import { Controller, Post, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminCatalogService } from '../../modules/admin/services/admin-catalog.service';

@Controller('admin/catalog')
@UseGuards(SharedSecretGuard)
export class AdminCatalogController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Post('covers/sync')
  async syncCovers() {
    const result = await this.adminCatalogService.syncCovers();
    return { ok: true, ...result };
  }

  @Post('covers/force-sync')
  async forceSyncCovers() {
    const result = await this.adminCatalogService.forceSyncCovers();
    return { ok: true, ...result };
  }

  @Post('covers/backfill-variants')
  async backfillCoverVariants() {
    const result = await this.adminCatalogService.backfillCoverVariants();
    return { ok: true, ...result };
  }

  @Post('music/sync')
  async syncMusic() {
    const result = await this.adminCatalogService.syncMusic();
    return { ok: true, ...result };
  }
}
