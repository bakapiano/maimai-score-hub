import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import { JobEntity } from '../../job/schemas/job.schema';
import { SyncEntity } from '../../sync/schemas/sync.schema';
import type { SyncDocument } from '../../sync/schemas/sync.schema';
import { UsersService } from './users.service';
import { PasskeyCredentialEntity } from '../../auth/schemas/passkey-credential.schema';
import { ProberExportJobEntity } from '../../prober-export/schemas/prober-export-job.schema';
import { ProberExportStateEntity } from '../../prober-export/schemas/prober-export-state.schema';
import { ScoreChangeEntity } from '../../sync/schemas/score-change.schema';

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly users: UsersService,
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncDocument>,
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    @InjectModel(PasskeyCredentialEntity.name)
    private readonly passkeyModel: Model<PasskeyCredentialEntity>,
    @InjectModel(ProberExportJobEntity.name)
    private readonly proberExportJobModel: Model<ProberExportJobEntity>,
    @InjectModel(ProberExportStateEntity.name)
    private readonly proberExportStateModel: Model<ProberExportStateEntity>,
    @InjectModel(ScoreChangeEntity.name)
    private readonly scoreChangeModel: Model<ScoreChangeEntity>,
  ) {}

  /**
   * Hard delete the current user and all data joined on friendCode.
   *
   * - users (this row)
   * - syncs   (latest sync snapshot keyed by friendCode)
   * - score_changes (best-effort per-chart history keyed by friendCode)
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
    const [
      syncRes,
      scoreChangeRes,
      jobRes,
      passkeyRes,
      exportJobRes,
      exportStateRes,
    ] = await Promise.all([
      this.syncModel.deleteMany({ friendCode }),
      this.scoreChangeModel.deleteMany({ friendCode }),
      this.jobModel.deleteMany({ friendCode }),
      this.passkeyModel.deleteMany({ userId: new Types.ObjectId(userId) }),
      this.proberExportJobModel.deleteMany({ friendCode }),
      this.proberExportStateModel.deleteMany({ friendCode }),
    ]);
    return {
      ok: true as const,
      friendCode,
      deleted: {
        user: 1,
        syncs: syncRes.deletedCount ?? 0,
        scoreChanges: scoreChangeRes.deletedCount ?? 0,
        jobs: jobRes.deletedCount ?? 0,
        passkeys: passkeyRes.deletedCount ?? 0,
        proberExportJobs: exportJobRes.deletedCount ?? 0,
        proberExportStates: exportStateRes.deletedCount ?? 0,
      },
    };
  }
}
