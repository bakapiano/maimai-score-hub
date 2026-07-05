import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createHash, randomUUID } from 'crypto';

import { SyncService } from '../../sync/services/sync.service';
import type { RecentFcFsEvent } from '../../sync/services/sync.service';
import { AutoUpdateActivityService } from '../../auto-update/services/auto-update-activity.service';
import { JobTempCacheService } from '../cache/temp-cache.service';
import { ProberExportService } from '../../prober-export/services/prober-export.service';
import type {
  JobPatchBody,
  JobResponse,
  JobStatus,
  JobType,
} from '../job.types';
import { getJobTypePriority } from '@maimai-score-hub/shared';
import { JobEntity } from '../schemas/job.schema';
import {
  initialStageForJobType,
  JOB_STAGE_MAP,
  VALID_STAGE,
  VALID_STATUS,
} from './job.constants';
import { JobFriendshipService } from './job-friendship.service';
import { JobQueueService } from './job-queue.service';
import { ObservabilityIngestService } from '../../observability/services/observability-ingest.service';
import { toJobResponse } from './job-response.mapper';

export interface RecentJobStats {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  avgDuration: number | null;
}

function getDxnetTimelineEventName(input: {
  statusChanged: boolean;
  stageChanged: boolean;
  delayed: boolean;
  toStatus: JobStatus;
}): string {
  if (input.statusChanged) {
    if (input.toStatus === 'processing') {
      return 'picked';
    }
    if (['completed', 'failed', 'canceled'].includes(input.toStatus)) {
      return input.toStatus;
    }
    return 'status_changed';
  }
  if (input.delayed) {
    return 'delayed';
  }
  if (input.stageChanged) {
    return 'stage_changed';
  }
  return 'patched';
}

// [TODO] Change this to 1min
// const MIN_CREATE_INTERVAL_MS = Number(
//   process.env.MIN_CREATE_INTERVAL_MS ?? 1000 * 60,
// );

@Injectable()
export class JobService {
  private readonly logger = new Logger(JobService.name);

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly syncService: SyncService,
    private readonly tempCacheService: JobTempCacheService,
    private readonly proberExports: ProberExportService,
    private readonly jobQueue: JobQueueService,
    private readonly friendship: JobFriendshipService,
    private readonly observability: ObservabilityIngestService,
    private readonly autoUpdateActivity: AutoUpdateActivityService,
  ) {}

  async create(input: {
    friendCode: string;
    jobType?: JobType;
    friendshipJobId?: string;
    botUserFriendCode?: string | null;
    friendshipReady?: boolean;
    diffsToScrape?: number[] | null;
    context?: Record<string, unknown> | null;
    removeFriendAfterComplete?: boolean;
    cancelActiveJobs?: boolean;
    runAt?: Date | string | null;
  }) {
    const id = randomUUID();
    const now = new Date();
    const resolvedJobType: JobType = input.jobType ?? 'send_friend_request';

    // [TODO] 将这个限流改为 ip 黑名单机制，同一时间对于一个 friend code 的请求如果过于频繁就拒绝
    // const recent = await this.jobModel
    //   .findOne({ friendCode: input.friendCode })
    //   .sort({ createdAt: -1 });
    // if (recent) {
    //   const diff = now.getTime() - recent.createdAt.getTime();
    //   if (diff < MIN_CREATE_INTERVAL_MS) {
    //     throw new BadRequestException('请求过于频繁，请等待一分钟过后重试！');
    //   }
    // }

    let resolvedStage = initialStageForJobType(resolvedJobType);

    // Cabinet-bound user fast-path: if the user has cabinetUserId, ask
    // sdgb to addRival on their behalf so update_score can start without
    // a manual DXNet friend request.
    //
    // 调用方（FE / scheduler）传 botUserFriendCode 是可选的：
    //   - auto-update / login follow-up passes botUserFriendCode and can
    //     start at update_score.
    //   - JobController.create（用户点"更新数据"）不传 bot；这里需要自己挑一个
    //     cabinet-bound bot. If sdgb addRival fails, the caller gets
    //     needs_friendship and may create an explicit send_friend_request job.
    //
    // sdgb 失败处理（用户区分）：
    //   - manual update_score: await addRival; if sdgb fails, surface
    //     needs_friendship so the frontend can explicitly run the friendship
    //     job before retrying update_score.
    //   - pre-assigned update_score: await addRival before worker dispatch too.
    if (resolvedJobType === 'update_score' && !input.friendshipReady) {
      const fastPath = await this.friendship.tryCabinetFastPath({
        friendCode: input.friendCode,
        botUserFriendCode: input.botUserFriendCode ?? null,
      });
      input.botUserFriendCode = fastPath.botUserFriendCode;
      input.friendshipReady = fastPath.friendshipReady;
      if (fastPath.friendshipReady) {
        resolvedStage = 'update_score';
      }
    }

    if (resolvedJobType === 'update_score') {
      const friendship = await this.friendship.resolveUpdateScoreFriendship({
        friendCode: input.friendCode,
        botUserFriendCode: input.botUserFriendCode ?? null,
        friendshipReady: input.friendshipReady ?? false,
      });

      if (friendship.ready) {
        input.botUserFriendCode = friendship.botUserFriendCode;
        resolvedStage = 'update_score';
      } else {
        const proofBotFriendCode =
          await this.friendship.resolveCompletedFriendshipProof({
            friendCode: input.friendCode,
            friendshipJobId: input.friendshipJobId,
            now,
          });
        if (proofBotFriendCode) {
          input.botUserFriendCode = proofBotFriendCode;
          resolvedStage = 'update_score';
        } else {
          throw new BadRequestException({
            code: 'needs_friendship',
            message: '请先让当前账号与可用 Bot 成为好友后再更新成绩',
            recommendedBotFriendCode: friendship.botUserFriendCode,
          });
        }
      }
    }

    input.botUserFriendCode = await this.friendship.resolveBotForCreate({
      friendCode: input.friendCode,
      jobType: resolvedJobType,
      botUserFriendCode: input.botUserFriendCode ?? null,
    });

    const priority = getJobTypePriority(resolvedJobType);

    if (input.cancelActiveJobs !== false) {
      await this.jobModel.updateMany(
        {
          friendCode: input.friendCode,
          status: { $nin: ['completed', 'failed', 'canceled'] },
        },
        {
          $set: {
            status: 'canceled',
            runAt: null,
            updatedAt: now,
          },
        },
      );
    }

    const created = await this.jobModel.create({
      id,
      friendCode: input.friendCode,
      jobType: resolvedJobType,
      priority,
      botUserFriendCode: input.botUserFriendCode ?? null,
      friendRequestSentAt: null,
      friendRequestWaitStartedAt:
        resolvedJobType === 'accept_friend_request' ? now.toISOString() : null,
      status: 'queued',
      stage: resolvedStage,
      error: null,
      result: undefined,
      diffsToScrape: input.diffsToScrape ?? null,
      context: input.context ?? null,
      removeFriendAfterComplete: input.removeFriendAfterComplete ?? false,
      runAt:
        input.runAt === undefined || input.runAt === null
          ? null
          : input.runAt instanceof Date
            ? input.runAt
            : this.parseIsoDate(input.runAt, 'runAt'),
      createdAt: now,
      updatedAt: now,
    });

    const createdEntity = created.toObject() as JobEntity;
    try {
      await this.jobQueue.enqueueWorkerJob(createdEntity);
    } catch (err) {
      await this.jobModel.updateOne(
        { id, status: 'queued' },
        {
          $set: {
            status: 'failed',
            runAt: null,
            error: `failed to enqueue dxnet BullMQ job: ${
              err instanceof Error ? err.message : String(err)
            }`,
            updatedAt: new Date(),
          },
        },
      );
      throw err;
    }
    this.observability.recordJobTimelineEvent({
      ts: now,
      jobId: id,
      jobKind: 'dxnet',
      jobType: resolvedJobType,
      eventName: 'created',
      toStatus: 'queued',
      toStage: resolvedStage,
      botFriendCode: input.botUserFriendCode ?? null,
      attrs: { priority },
    });
    this.observability.recordJobTimelineEvent({
      ts: now,
      jobId: id,
      jobKind: 'dxnet',
      jobType: resolvedJobType,
      eventName: 'queued',
      toStatus: 'queued',
      toStage: resolvedStage,
      botFriendCode: input.botUserFriendCode ?? null,
    });
    return { jobId: id, job: toJobResponse(createdEntity) };
  }

  async get(jobId: string): Promise<JobResponse> {
    const job = await this.jobModel.findOne({ id: jobId });
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    return toJobResponse(job.toObject() as JobEntity);
  }

  async wake(jobId: string): Promise<JobResponse> {
    const existing = await this.jobModel.findOne({ id: jobId });
    if (!existing) {
      throw new NotFoundException('Job not found');
    }

    if (['completed', 'failed', 'canceled'].includes(existing.status)) {
      return toJobResponse(existing.toObject() as JobEntity);
    }

    const updated = await this.jobModel.findOneAndUpdate(
      { id: jobId },
      {
        $set: {
          runAt: null,
          updatedAt: new Date(),
        },
      },
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException('Job not found');
    }

    await this.jobQueue.promoteOrEnqueueWorkerJob(
      updated.toObject() as JobEntity,
    );
    return toJobResponse(updated.toObject() as JobEntity);
  }

  async patch(jobId: string, body: JobPatchBody): Promise<JobResponse> {
    const existing = await this.jobModel.findOne({ id: jobId }).lean();
    if (!existing) {
      throw new NotFoundException('Job not found');
    }
    const { updateOps, finalStatuses } = this.buildPatchOperations(
      existing as JobEntity,
      body,
    );

    const updated = await this.jobModel.findOneAndUpdate(
      { id: jobId },
      updateOps,
      { new: true },
    );

    if (!updated) {
      throw new NotFoundException('Job not found');
    }

    this.cleanupFinalJobCache(jobId, updated.status, finalStatuses);
    await this.handleCompletedUpdateScore(
      updated.toObject() as JobEntity,
      jobId,
    );
    await this.handleCompletedRecentEvent(
      updated.toObject() as JobEntity,
      jobId,
    );

    const updatedEntity = updated.toObject() as JobEntity;
    this.recordPatchTimeline(existing as JobEntity, updatedEntity, body);

    return toJobResponse(updatedEntity);
  }

  private recordPatchTimeline(
    existing: JobEntity,
    updated: JobEntity,
    body: JobPatchBody,
  ): void {
    const statusChanged = existing.status !== updated.status;
    const stageChanged = existing.stage !== updated.stage;
    const delayed = body.runAt !== undefined && updated.runAt !== null;
    if (!statusChanged && !stageChanged && !delayed) {
      return;
    }

    const eventName = getDxnetTimelineEventName({
      statusChanged,
      stageChanged,
      delayed,
      toStatus: updated.status,
    });
    this.observability.recordJobTimelineEvent({
      ts: updated.updatedAt,
      jobId: updated.id,
      jobKind: 'dxnet',
      jobType: updated.jobType,
      eventName,
      fromStatus: statusChanged ? existing.status : null,
      toStatus: statusChanged ? updated.status : null,
      fromStage: stageChanged ? existing.stage : null,
      toStage: stageChanged ? updated.stage : null,
      botFriendCode: updated.botUserFriendCode,
      durationMs: ['completed', 'failed', 'canceled'].includes(updated.status)
        ? updated.updatedAt.getTime() - updated.createdAt.getTime()
        : null,
      errorClass: updated.status === 'failed' ? 'dxnet_job_failed' : null,
      message: updated.error,
      attrs: {
        runAt: updated.runAt ? updated.runAt.toISOString() : '',
      },
    });
  }

  private buildPatchOperations(
    existing: JobEntity,
    body: JobPatchBody,
  ): {
    updateOps: Record<string, unknown>;
    finalStatuses: JobStatus[];
  } {
    const update: Partial<JobEntity> = {};
    const additionalOps: Record<string, unknown> = {};
    const finalStatuses: JobStatus[] = ['completed', 'failed', 'canceled'];

    this.applyBotUserFriendCodePatch(update, body);
    this.applyStatusPatch(update, body);
    this.applyStagePatch(update, body, existing);
    this.applyMixedPatch(update, body);
    this.applyStringOrNullPatch(update, body);
    this.applyDatePatch(update, body);
    this.applyScorePatch(update, additionalOps, body);
    if (body.status && finalStatuses.includes(body.status)) {
      update.runAt = null;
    }

    return { updateOps: { $set: update, ...additionalOps }, finalStatuses };
  }

  private applyBotUserFriendCodePatch(
    update: Partial<JobEntity>,
    body: JobPatchBody,
  ): void {
    if (body.botUserFriendCode === undefined) {
      return;
    }
    if (
      body.botUserFriendCode !== null &&
      typeof body.botUserFriendCode !== 'string'
    ) {
      throw new BadRequestException(
        'botUserFriendCode must be a string or null',
      );
    }
    update.botUserFriendCode = body.botUserFriendCode;
  }

  private applyStatusPatch(
    update: Partial<JobEntity>,
    body: JobPatchBody,
  ): void {
    if (body.status === undefined) {
      return;
    }
    if (!VALID_STATUS.includes(body.status)) {
      throw new BadRequestException('Invalid status value');
    }
    update.status = body.status;
  }

  private applyStagePatch(
    update: Partial<JobEntity>,
    body: JobPatchBody,
    existing: JobEntity,
  ): void {
    if (body.stage === undefined) {
      return;
    }
    if (!VALID_STAGE.includes(body.stage)) {
      throw new BadRequestException('Invalid stage value');
    }
    if (!JOB_STAGE_MAP[existing.jobType]?.includes(body.stage)) {
      throw new BadRequestException(
        `Invalid stage ${body.stage} for jobType ${existing.jobType}`,
      );
    }
    update.stage = body.stage;
  }

  private applyMixedPatch(
    update: Partial<JobEntity>,
    body: JobPatchBody,
  ): void {
    if (body.result !== undefined) {
      update.result = body.result;
    }
    if (body.profile !== undefined) {
      update.profile = body.profile;
    }
  }

  private applyStringOrNullPatch(
    update: Partial<JobEntity>,
    body: JobPatchBody,
  ): void {
    this.applyNullableStringField(update, 'error', body.error, 'error');
    this.applyNullableStringField(
      update,
      'friendRequestSentAt',
      body.friendRequestSentAt,
      'friendRequestSentAt',
    );
    this.applyNullableStringField(
      update,
      'friendRequestWaitStartedAt',
      body.friendRequestWaitStartedAt,
      'friendRequestWaitStartedAt',
    );
  }

  private applyNullableStringField(
    update: Partial<JobEntity>,
    key: 'error' | 'friendRequestSentAt' | 'friendRequestWaitStartedAt',
    value: string | null | undefined,
    field: string,
  ): void {
    if (value === undefined) {
      return;
    }
    if (value !== null && typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string or null`);
    }
    update[key] = value;
  }

  private applyDatePatch(update: Partial<JobEntity>, body: JobPatchBody): void {
    if (body.runAt !== undefined) {
      update.runAt =
        body.runAt === null ? null : this.parseIsoDate(body.runAt, 'runAt');
    }
    update.updatedAt =
      body.updatedAt !== undefined
        ? this.parseIsoDate(body.updatedAt, 'updatedAt')
        : new Date();
  }

  private parseIsoDate(value: string, field: string): Date {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be an ISO string`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO date`);
    }
    return parsed;
  }

  private applyScorePatch(
    update: Partial<JobEntity>,
    additionalOps: Record<string, unknown>,
    body: JobPatchBody,
  ): void {
    if (body.updateScoreDuration !== undefined) {
      if (
        body.updateScoreDuration !== null &&
        typeof body.updateScoreDuration !== 'number'
      ) {
        throw new BadRequestException(
          'updateScoreDuration must be a number or null',
        );
      }
      update.updateScoreDuration = body.updateScoreDuration;
    }
    if (body.scoreProgress !== undefined) {
      update.scoreProgress = body.scoreProgress;
    }
    if (body.addCompletedDiff !== undefined) {
      if (typeof body.addCompletedDiff !== 'number') {
        throw new BadRequestException('addCompletedDiff must be a number');
      }
      additionalOps.$addToSet = {
        'scoreProgress.completedDiffs': body.addCompletedDiff,
      };
    }
  }

  private cleanupFinalJobCache(
    jobId: string,
    status: JobStatus,
    finalStatuses: JobStatus[],
  ): void {
    if (!finalStatuses.includes(status)) {
      return;
    }
    this.tempCacheService.deleteByJobId(jobId).catch((err) => {
      console.error(`Failed to delete temp cache for job ${jobId}:`, err);
    });
  }

  private async handleCompletedUpdateScore(
    updated: JobEntity,
    jobId: string,
  ): Promise<void> {
    if (
      updated.status !== 'completed' ||
      updated.jobType !== 'update_score' ||
      !updated.result
    ) {
      return;
    }
    const sync = await this.syncService.createFromJob(updated);
    if (!sync?.id) {
      return;
    }
    this.proberExports
      .enqueueAutoExportForSync({
        trigger: 'dxnet_update_score',
        friendCode: updated.friendCode,
        syncId: sync.id,
        sourceJobId: jobId,
      })
      .catch((err: Error) => {
        this.logger.error(
          `Failed to enqueue auto-export for job ${jobId}: ${err?.message}`,
        );
      });
  }

  private async handleCompletedRecentEvent(
    updated: JobEntity,
    jobId: string,
  ): Promise<void> {
    if (
      updated.status !== 'completed' ||
      updated.jobType !== 'get_user_recent_event' ||
      !updated.result
    ) {
      return;
    }
    const events = (updated.result as { events?: unknown }).events;
    if (!Array.isArray(events)) {
      return;
    }
    const context = updated.context ?? null;
    const mergeResult = await this.syncService.mergeRecentEvents({
      friendCode: updated.friendCode,
      sourceId: jobId,
      events: events as RecentFcFsEvent[],
    });
    this.enqueueFcfsAutoExport(updated, jobId, mergeResult);
    if (context?.autoUpdateFcfs === true) {
      await this.autoUpdateActivity.recordRecentEventFingerprint({
        friendCode: updated.friendCode,
        fingerprint: this.recentEventFingerprint(events),
        at: updated.updatedAt,
      });
    }
  }

  private enqueueFcfsAutoExport(
    updated: JobEntity,
    jobId: string,
    mergeResult: {
      updatedCount: number;
      syncId: string | null;
    },
  ): void {
    if (
      updated.context?.autoUpdateFcfs !== true ||
      mergeResult.updatedCount <= 0 ||
      !mergeResult.syncId
    ) {
      return;
    }
    this.proberExports
      .enqueueAutoExportForSync({
        trigger: 'auto_update_fcfs',
        friendCode: updated.friendCode,
        syncId: mergeResult.syncId,
        sourceJobId: jobId,
      })
      .catch((err: Error) => {
        this.logger.warn(
          `failed to enqueue fcfs auto-export job=${jobId}: ${err?.message}`,
        );
      });
  }

  private recentEventFingerprint(events: unknown[]): string {
    const rows = events.map((event) => {
      if (!event || typeof event !== 'object') {
        return ['', '', '', '', ''];
      }
      const row = event as Record<string, unknown>;
      return [
        typeof row.time === 'string' ? row.time : '',
        typeof row.songName === 'string' ? row.songName : '',
        typeof row.difficulty === 'string' ? row.difficulty : '',
        typeof row.fc === 'string' ? row.fc : '',
        typeof row.fs === 'string' ? row.fs : '',
      ];
    });
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  async getActiveFriendCodesByBot(
    botUserFriendCode: string,
  ): Promise<string[]> {
    const jobs = await this.jobModel
      .find({
        botUserFriendCode,
        status: { $nin: ['completed', 'failed', 'canceled'] },
      })
      .select('friendCode')
      .lean();

    return jobs.map((job) => job.friendCode);
  }

  /**
   * 根据 friendCode 获取当前正在执行的成绩更新相关任务。
   */
  async getActiveByFriendCode(friendCode: string): Promise<JobResponse | null> {
    const job = await this.jobModel
      .findOne({
        friendCode,
        jobType: { $in: ['update_score', 'send_friend_request'] },
        status: { $in: ['queued', 'processing'] },
      })
      .sort({ createdAt: -1 });

    if (!job) {
      return null;
    }

    return toJobResponse(job.toObject() as JobEntity);
  }

  async getActiveUpdateScoreByFriendCode(
    friendCode: string,
  ): Promise<JobResponse | null> {
    const job = await this.jobModel
      .findOne({
        friendCode,
        jobType: 'update_score',
        status: { $in: ['queued', 'processing'] },
      })
      .sort({ createdAt: -1 });

    if (!job) {
      return null;
    }

    return toJobResponse(job.toObject() as JobEntity);
  }

  async getRecentStats(): Promise<RecentJobStats> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const filter = {
      jobType: 'update_score',
      createdAt: { $gte: oneHourAgo },
    };

    const [totalCount, completedCount, failedCount] = await Promise.all([
      this.jobModel.countDocuments(filter),
      this.jobModel.countDocuments({ ...filter, status: 'completed' }),
      this.jobModel.countDocuments({ ...filter, status: 'failed' }),
    ]);

    // 获取有 updateScoreDuration 的已完成任务的平均时长
    const durationStats = await this.jobModel.aggregate<{
      avgDuration: number;
    }>([
      {
        $match: {
          ...filter,
          status: 'completed',
          updateScoreDuration: { $ne: null, $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          avgDuration: { $avg: '$updateScoreDuration' },
        },
      },
    ]);

    const avgDuration = durationStats[0]
      ? Math.round(durationStats[0].avgDuration)
      : null;

    return {
      totalCount,
      completedCount,
      failedCount,
      successRate:
        totalCount > 0
          ? Math.round((completedCount / totalCount) * 10000) / 100
          : 0,
      avgDuration,
    };
  }

  /**
   * 清理创建时间在七天之前的所有 job
   */
  async cleanupOldJobs(): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.jobModel.deleteMany({
      createdAt: { $lt: sevenDaysAgo },
    });
    return result.deletedCount;
  }
}
