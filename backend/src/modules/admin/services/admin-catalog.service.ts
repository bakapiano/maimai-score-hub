import { Injectable } from '@nestjs/common';

import { CoverService } from '../../cover/services/cover.service';
import { MusicService } from '../../music/services/music.service';

@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly coverService: CoverService,
    private readonly musicService: MusicService,
  ) {}

  async syncCovers() {
    return this.coverService.syncAll();
  }

  async forceSyncCovers() {
    return this.coverService.forceSyncAll();
  }

  async backfillCoverVariants() {
    return this.coverService.backfillLocalVariants();
  }

  async syncMusic() {
    return this.musicService.syncMusicData();
  }
}
