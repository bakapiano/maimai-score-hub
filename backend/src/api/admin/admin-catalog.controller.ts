import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import {
  SetMusicSourceBodySchema,
  type SetMusicSourceBody,
} from '@maimai-score-hub/shared';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminService } from '../../modules/admin/services/admin.service';
import { MusicService } from '../../modules/music/services/music.service';
import type { MusicDataSource } from '../../modules/music/schemas/music-config.schema';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('admin/catalog')
@UseGuards(SharedSecretGuard)
export class AdminCatalogController {
  constructor(
    private readonly adminService: AdminService,
    private readonly musicService: MusicService,
  ) {}

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

  @Get('music/source')
  async getMusicDataSource() {
    const source = await this.musicService.getDataSource();
    return { source };
  }

  @Put('music/source')
  async setMusicDataSource(
    @Body(new ZodValidationPipe(SetMusicSourceBodySchema))
    body: SetMusicSourceBody,
  ) {
    const { source } = body;
    await this.musicService.setDataSource(source as MusicDataSource);
    return { ok: true, source };
  }
}
