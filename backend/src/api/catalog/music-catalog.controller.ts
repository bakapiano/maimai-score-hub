import { Controller, Get } from '@nestjs/common';

import { MusicService } from '../../modules/music/services/music.service';

@Controller('catalog/music')
export class MusicCatalogController {
  constructor(private readonly musicService: MusicService) {}

  @Get()
  async listAll() {
    return this.musicService.findAll();
  }
}
