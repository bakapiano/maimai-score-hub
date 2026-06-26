import { Controller, Post, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminService } from '../../modules/admin/services/admin.service';

@Controller('admin/catalog')
@UseGuards(SharedSecretGuard)
export class AdminCatalogController {
  constructor(private readonly adminService: AdminService) {}

  @Post('covers/sync')
  async syncCovers() {
    const result = await this.adminService.syncCovers();
    return { ok: true, ...result };
  }

  @Post('covers/force-sync')
  async forceSyncCovers() {
    const result = await this.adminService.forceSyncCovers();
    return { ok: true, ...result };
  }

  @Post('covers/backfill-variants')
  async backfillCoverVariants() {
    const result = await this.adminService.backfillCoverVariants();
    return { ok: true, ...result };
  }

  @Post('music/sync')
  async syncMusic() {
    const result = await this.adminService.syncMusic();
    return { ok: true, ...result };
  }
}
