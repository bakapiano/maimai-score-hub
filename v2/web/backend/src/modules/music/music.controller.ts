import { Controller, Get, Post } from '@nestjs/common';

import { MusicService } from './music.service';

@Controller('music')
export class MusicController {
  constructor(private readonly musicService: MusicService) {}

  @Get()
  async listAll() {
    return this.musicService.findAll();
  }

  @Post('sync')
  async forceSync() {
    const summary = await this.musicService.syncMusicData();
    return { ok: true, ...summary };
  }
}
