import { Controller, Get, Header } from '@nestjs/common';

import { MusicAliasService } from '../../modules/music-alias/services/music-alias.service';
import { MusicService } from '../../modules/music/services/music.service';

@Controller('catalog/music')
export class MusicCatalogController {
  constructor(
    private readonly musicService: MusicService,
    private readonly musicAliasService: MusicAliasService,
  ) {}

  @Get()
  @Header(
    'Cache-Control',
    'public, max-age=600, s-maxage=1800, stale-while-revalidate=3600',
  )
  async listAll() {
    return this.musicService.findAll();
  }

  @Get('aliases')
  @Header(
    'Cache-Control',
    'public, max-age=600, s-maxage=1800, stale-while-revalidate=3600',
  )
  async listAliases() {
    return this.musicAliasService.findAll();
  }
}
