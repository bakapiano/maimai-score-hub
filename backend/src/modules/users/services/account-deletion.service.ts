import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { JobEntity } from '../../job/schemas/job.schema';
import { SyncEntity } from '../../sync/schemas/sync.schema';
import type { SyncDocument } from '../../sync/schemas/sync.schema';
import { UsersService } from './users.service';

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly users: UsersService,
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncDocument>,
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
  ) {}

  /**
   * Hard delete the current user and all data joined on friendCode.
   *
   * - users (this row)
   * - syncs   (latest sync snapshot keyed by friendCode)
   * - jobs    (every dxnet job — send_friend_request / accept_friend_request / update_score)
   *
   * NOT touched (intentional, since they aren't user-specific or auto-expire):
   * - sdgb_jobs (TTL'd, plus tagged by friendCode in requesterTag — would need
   *   a $regex sweep; deleting auto-expires within 24h)
   * - bot_statuses.friends (rebuilt on next worker tick)
   * - auto_update_runs (per-cron-bucket, not per-user)
   */
  async deleteAccount(userId: string) {
    const { friendCode } = await this.users.deleteAccount(userId);
    const [syncRes, jobRes] = await Promise.all([
      this.syncModel.deleteMany({ friendCode }),
      this.jobModel.deleteMany({ friendCode }),
    ]);
    return {
      ok: true as const,
      friendCode,
      deleted: {
        user: 1,
        syncs: syncRes.deletedCount ?? 0,
        jobs: jobRes.deletedCount ?? 0,
      },
    };
  }
}
