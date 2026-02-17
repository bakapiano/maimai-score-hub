import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  SetMusicSourceBodySchema,
  type SetMusicSourceBody,
} from '@maimai-score-hub/shared';

import { MusicService } from './music.service';
import type { MusicDataSource } from './music-config.schema';
import { AdminGuard } from '../admin/admin.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@Controller('music')
export class MusicController {
  constructor(private readonly musicService: MusicService) {}

  @Get()
  async listAll() {
    return this.musicService.findAll();
  }

  @Post('sync')
  @UseGuards(AdminGuard)
  async forceSync() {
    const summary = await this.musicService.syncMusicData();
    return { ok: true, ...summary };
  }

  @Get('source')
  async getDataSource() {
    const source = await this.musicService.getDataSource();
    return { source };
  }

  @Post('source')
  @UseGuards(AdminGuard)
  async setDataSource(
    @Body(new ZodValidationPipe(SetMusicSourceBodySchema)) body: SetMusicSourceBody,
  ) {
    const { source } = body;
    await this.musicService.setDataSource(source as MusicDataSource);
    return { ok: true, source };
  }
}
