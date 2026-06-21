import { Controller, Get } from '@nestjs/common';

import { MusicService } from './music.service';

@Controller('catalog/music')
export class MusicController {
  constructor(private readonly musicService: MusicService) {}

  @Get()
  async listAll() {
    return this.musicService.findAll();
  }
}
