import {
  Controller,
  Get,
  Post,
  Body,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';

import { MusicService } from './music.service';
import type { MusicDataSource } from './music-config.schema';
import { AdminGuard } from '../admin/admin.guard';

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
  async setDataSource(@Body() body: { source: string }) {
    const { source } = body;
    if (source !== 'diving-fish' && source !== 'lxns') {
      throw new BadRequestException(
        'Invalid source. Must be "diving-fish" or "lxns"',
      );
    }
    await this.musicService.setDataSource(source as MusicDataSource);
    return { ok: true, source };
  }
}
