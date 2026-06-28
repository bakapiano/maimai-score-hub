import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { CoverService } from '../../cover/services/cover.service';
import { MusicEntity } from '../../music/schemas/music.schema';
import { SyncEntity } from '../../sync/schemas/sync.schema';
import { UserEntity } from '../../users/schemas/user.schema';
import type { AdminStats } from './admin.types';

@Injectable()
export class AdminSummaryService {
  constructor(
    @InjectModel(UserEntity.name)
    private readonly userModel: Model<UserEntity>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicEntity>,
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncEntity>,
    private readonly coverService: CoverService,
  ) {}

  async getStats(): Promise<AdminStats> {
    const [userCount, musicCount, syncCount, coverCount] = await Promise.all([
      this.userModel.estimatedDocumentCount(),
      this.musicModel.estimatedDocumentCount(),
      this.syncModel.estimatedDocumentCount(),
      this.coverService.getCoverCount(),
    ]);

    return {
      userCount,
      musicCount,
      syncCount,
      coverCount,
    };
  }
}
