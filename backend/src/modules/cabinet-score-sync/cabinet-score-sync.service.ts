import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  GetMusicScoreResultSchema,
  type CabinetScoreJob,
  type SdgbJobPatchBody,
} from '@maimai-score-hub/shared';

import { RedisService } from '../../common/redis/redis.service';
import { JobService } from '../job/services/job.service';
import { ProberExportService } from '../prober-export/services/prober-export.service';
import {
  SdgbJobService,
  type SdgbJobView,
} from '../sdgb-worker/services/sdgb-job.service';
import { SyncService } from '../sync/services/sync.service';
import { UsersService } from '../users/services/users.service';

const CREATE_LOCK_TTL_MS = 10_000;

@Injectable()
export class CabinetScoreSyncService {
  private readonly logger = new Logger(CabinetScoreSyncService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly sdgbJobs: SdgbJobService,
    private readonly dxnetJobs: JobService,
    private readonly users: UsersService,
    private readonly syncs: SyncService,
    private readonly proberExports: ProberExportService,
  ) {}

  async create(ownerUserId: string, qrCode: string) {
    const user = await this.users.getById(ownerUserId);
    if (user.cabinetUserId === null || user.cabinetUserId === undefined) {
      throw new ConflictException({
        code: 'CABINET_NOT_BOUND',
        message: '请先完成二维码绑定',
      });
    }

    return this.withCreateLock(user.friendCode, async () => {
      const [cabinetActive, dxnetActive] = await Promise.all([
        this.sdgbJobs.getActiveOwned(ownerUserId),
        this.dxnetJobs.getActiveByFriendCode(user.friendCode),
      ]);
      if (cabinetActive || dxnetActive) {
        const retryAfter = cabinetActive?.cleanupBlockedUntil ?? undefined;
        throw new ConflictException({
          code: cabinetActive ? 'SESSION_CLEANUP_PENDING' : 'SYNC_IN_PROGRESS',
          message: cabinetActive
            ? '正在处理上一次二维码登录状态，请稍后再试'
            : '已有成绩更新任务进行中',
          ...(retryAfter ? { retryAfter } : {}),
        });
      }

      const job = await this.sdgbJobs.enqueue({
        jobType: 'get_music_score',
        payload: {
          qrCode,
          expectedCabinetUserId: user.cabinetUserId,
        },
        requesterTag: `cabinet-score:${user.friendCode}`,
        ownerUserId,
        ownerFriendCode: user.friendCode,
      });
      return { jobId: job.id, job: this.toPublicJob(job) };
    });
  }

  async getOwned(jobId: string, ownerUserId: string): Promise<CabinetScoreJob> {
    return this.toPublicJob(await this.sdgbJobs.getOwned(jobId, ownerUserId));
  }

  async getActiveOwned(
    ownerUserId: string,
  ): Promise<{ job: CabinetScoreJob | null }> {
    const job = await this.sdgbJobs.getActiveOwned(ownerUserId);
    return { job: job ? this.toPublicJob(job) : null };
  }

  async assertNoActiveCabinetJob(ownerUserId: string): Promise<void> {
    const active = await this.sdgbJobs.getActiveOwned(ownerUserId);
    if (active) {
      throw new ConflictException({
        code: 'SYNC_IN_PROGRESS',
        message: '已有二维码成绩任务或登录状态清理进行中',
      });
    }
  }

  async withCreateLock<T>(
    friendCode: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = this.redis.key(`lock:manual-score-create:${friendCode}`);
    const token = randomUUID();
    if (!(await this.redis.setNx(key, token, CREATE_LOCK_TTL_MS))) {
      throw new ConflictException({
        code: 'SYNC_IN_PROGRESS',
        message: '正在创建成绩更新任务，请稍后再试',
      });
    }
    try {
      return await task();
    } finally {
      await this.redis.compareAndDelete(key, token).catch(() => undefined);
    }
  }

  async patchFromWorker(jobId: string, body: SdgbJobPatchBody) {
    const job = await this.sdgbJobs.getEntity(jobId);
    if (job.jobType !== 'get_music_score' || body.status !== 'completed') {
      return this.sdgbJobs.patchFromWorker(jobId, body);
    }
    return this.finalize(jobId, body.result, body);
  }

  private async finalize(
    jobId: string,
    rawResult: unknown,
    body: SdgbJobPatchBody,
  ) {
    await this.sdgbJobs.assertWorkerExecution(jobId, body);
    const result = GetMusicScoreResultSchema.parse(rawResult);
    const job = await this.sdgbJobs.getEntity(jobId);
    if (!job.ownerUserId || !job.ownerFriendCode) {
      return this.failFinalization(
        jobId,
        'SYNC_PERSIST_FAILED',
        'job owner missing',
        body,
      );
    }
    if (job.cleanupStatus !== 'succeeded') {
      throw new BadRequestException(
        'cannot persist cabinet scores before session cleanup succeeds',
      );
    }
    const user = await this.users.getById(job.ownerUserId);
    const expected = Number(job.payload.expectedCabinetUserId);
    if (user.cabinetUserId !== expected || result.cabinetUserId !== expected) {
      return this.failFinalization(
        jobId,
        'CABINET_USER_MISMATCH',
        'cabinet user id mismatch',
        body,
      );
    }

    try {
      const sync = await this.syncs.createFromUserMusic({
        friendCode: job.ownerFriendCode,
        sourceId: jobId,
        musicDetails: result.musicDetails,
      });
      if (!sync?.id) {
        return this.failFinalization(
          jobId,
          'NO_SCORE_DATA',
          'no usable scores',
          body,
        );
      }
      const completed = await this.sdgbJobs.completeMusicScoreFinalization(
        jobId,
        {
          syncId: sync.id,
          scoreCount: Array.isArray(sync.scores) ? sync.scores.length : 0,
        },
        body,
      );
      void this.proberExports
        .enqueueAutoExportForSync({
          trigger: 'cabinet_qr_update',
          friendCode: job.ownerFriendCode,
          syncId: sync.id,
          sourceJobId: jobId,
        })
        .catch((err: Error) =>
          this.logger.warn(`cabinet score auto-export failed: ${err.message}`),
        );
      return completed;
    } catch (err) {
      return this.failFinalization(
        jobId,
        'SYNC_PERSIST_FAILED',
        err instanceof Error ? err.message : String(err),
        body,
      );
    }
  }

  private async failFinalization(
    jobId: string,
    errorCode: string,
    message: string,
    execution: SdgbJobPatchBody,
  ) {
    return this.sdgbJobs.patchFromWorker(jobId, {
      executionToken: execution.executionToken,
      executionWorkerId: execution.executionWorkerId,
      executionMembershipEpoch: execution.executionMembershipEpoch,
      executionNetworkEpoch: execution.executionNetworkEpoch,
      status: 'failed',
      errorCode,
      error: message,
    });
  }

  private toPublicJob(job: SdgbJobView): CabinetScoreJob {
    const summary = (job.result ?? {}) as {
      syncId?: unknown;
      scoreCount?: unknown;
    };
    const retryAfter = job.cleanupBlockedUntil ?? undefined;
    return {
      id: job.id,
      method: 'cabinet_qr',
      status: job.status,
      stage: job.stage ?? 'queued',
      cleanupStatus: job.cleanupStatus,
      progress: job.progress,
      syncId: typeof summary.syncId === 'string' ? summary.syncId : null,
      scoreCount:
        typeof summary.scoreCount === 'number' ? summary.scoreCount : null,
      error:
        job.error || job.errorCode
          ? {
              code: job.errorCode ?? 'CABINET_SCORE_JOB_FAILED',
              message: this.publicErrorMessage(job.errorCode, job.error),
              ...(retryAfter ? { retryAfter } : {}),
            }
          : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private publicErrorMessage(code: string | null, fallback: string | null) {
    const known: Record<string, string> = {
      QR_EXPIRED: '二维码已过期，请刷新后重新提交',
      CABINET_USER_MISMATCH: '二维码与当前绑定账号不一致',
      ACCOUNT_ALREADY_LOGGED_IN: '账号正在机台登录中，请结束游玩后再试',
      SESSION_CLEANUP_PENDING: '正在清理上一次登录状态，请稍后再试',
      SESSION_CLEANUP_UNCONFIRMED: '暂时无法确认已安全退出',
      WORKER_INTERRUPTED_SESSION_CLEANED:
        'Worker 中断，登录状态已清理；请使用新二维码重试',
      NO_SCORE_DATA: '未读取到可用成绩',
      SYNC_PERSIST_FAILED: '成绩保存失败',
    };
    return (code && known[code]) || fallback || '二维码成绩任务失败';
  }
}
