import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { Interval } from '@nestjs/schedule';

import { SyncService } from '../../sync/services/sync.service';
import { UsersService } from '../../users/services/users.service';
import { JobTempCacheService } from '../cache/temp-cache.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { BotFriendSnapshotService } from '../../bots/services/bot-friend-snapshot.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { AUTO_UPDATE_BACKOFF_POLICY } from '../../auto-update/auto-update-backoff';
import type {
  JobPatchBody,
  JobResponse,
  JobStage,
  JobStatus,
  JobType,
} from '../job.types';
import { getJobTypePriority } from '@maimai-score-hub/shared';
import { JobEntity } from '../schemas/job.schema';
import {
  DEFAULT_WORKER_JOB_OPTIONS,
  DXNET_WORKER_QUEUE_NAME,
  type DxnetWorkerJobData,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';

export interface RecentJobStats {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  avgDuration: number | null;
}

const DEAD_JOB_TIMEOUT_MS = Number(
  process.env.DEAD_JOB_TIMEOUT_MS ?? 1 * 30 * 1000,
);

/** Queued jobs older than this are automatically failed (default: 5 min) */
const QUEUED_JOB_TIMEOUT_MS = Number(
  process.env.QUEUED_JOB_TIMEOUT_MS ?? 5 * 60 * 1000,
);

/**
 * Hard ceiling on any non-terminal job (default: 30 min). Worker has its
 * own 30-min watchdog that PATCHes failed; this is the backstop for when
 * the worker dies or its PATCH never lands.
 */
const PROCESSING_HARD_TIMEOUT_MS = Number(
  process.env.PROCESSING_HARD_TIMEOUT_MS ?? 30 * 60 * 1000,
);

const DISPATCH_SWEEP_INTERVAL_MS = Number(
  process.env.DXNET_DISPATCH_SWEEP_INTERVAL_MS ?? 30_000,
);

const FRIENDSHIP_PROOF_MAX_AGE_MS = 10 * 60 * 1000;

// [TODO] Change this to 1min
// const MIN_CREATE_INTERVAL_MS = Number(
//   process.env.MIN_CREATE_INTERVAL_MS ?? 1000 * 60,
// );

function toJobResponse(job: JobEntity): JobResponse {
  return {
    id: job.id,
    friendCode: job.friendCode,
    jobType: job.jobType ?? 'send_friend_request',
    priority: job.priority ?? getJobTypePriority(job.jobType),
    botUserFriendCode: job.botUserFriendCode ?? null,
    friendRequestSentAt: job.friendRequestSentAt ?? null,
    friendRequestWaitStartedAt: job.friendRequestWaitStartedAt ?? null,
    status: job.status,
    stage: job.stage,
    // result: job.result,
    profile: job.profile,
    scoreProgress: job.scoreProgress ?? null,
    updateScoreDuration: job.updateScoreDuration ?? null,
    diffsToScrape: job.diffsToScrape ?? null,
    context: job.context ?? null,
    autoExportResult: job.autoExportResult ?? null,
    runAt: job.runAt?.toISOString() ?? null,
    error: job.error ?? null,
    executing: job.executing,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const VALID_STATUS: readonly JobStatus[] = [
  'queued',
  'processing',
  'completed',
  'canceled',
  'failed',
] as const;

const VALID_STAGE: readonly JobStage[] = [
  'send_request',
  'wait_acceptance',
  'wait_user_request',
  'accept_request',
  'update_score',
  'get_user_recent_event',
  'get_full_friend_list',
] as const;

const JOB_STAGE_MAP: Record<JobType, readonly JobStage[]> = {
  send_friend_request: ['send_request', 'wait_acceptance'],
  accept_friend_request: ['wait_user_request', 'accept_request'],
  update_score: ['update_score'],
  get_user_recent_event: ['get_user_recent_event'],
  get_full_friend_list: ['get_full_friend_list'],
};

@Injectable()
export class JobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobService.name);
  private readonly dxnetQueue: Queue<DxnetWorkerJobData>;
  private dispatchSweepRunning = false;

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly syncService: SyncService,
    private readonly tempCacheService: JobTempCacheService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly sdgb: SdgbJobDispatcher,
    private readonly botFriendSnapshot: BotFriendSnapshotService,
    @Inject(forwardRef(() => BotStatusService))
    private readonly botStatus: BotStatusService,
    config: ConfigService,
  ) {
    this.dxnetQueue = new Queue<DxnetWorkerJobData>(DXNET_WORKER_QUEUE_NAME, {
      ...createBullmqQueueOptions(config),
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.sweepAndDispatchJobs();
  }

  async onModuleDestroy(): Promise<void> {
    await this.dxnetQueue.close();
  }

  @Interval(DISPATCH_SWEEP_INTERVAL_MS)
  private async sweepAndDispatchJobs(): Promise<void> {
    if (this.dispatchSweepRunning) return;
    this.dispatchSweepRunning = true;
    try {
      const now = new Date();
      await this.releaseStaleAndTimedOutJobs(now);

      const dispatchable = await this.jobModel
        .find({
          status: { $in: ['queued', 'processing'] },
          executing: false,
        })
        .sort({ priority: -1, updatedAt: 1 })
        .limit(500)
        .lean<JobEntity[]>()
        .exec();

      await Promise.all(dispatchable.map((job) => this.enqueueWorkerJob(job)));
    } catch (err) {
      this.logger.warn(
        `dxnet BullMQ dispatch sweep failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    } finally {
      this.dispatchSweepRunning = false;
    }
  }

  private async releaseStaleAndTimedOutJobs(now: Date): Promise<void> {
    const staleThreshold = new Date(now.getTime() - DEAD_JOB_TIMEOUT_MS);
    await this.jobModel.updateMany(
      { executing: true, updatedAt: { $lte: staleThreshold } },
      { $set: { executing: false, updatedAt: now } },
    );

    const queuedDeadline = new Date(now.getTime() - QUEUED_JOB_TIMEOUT_MS);
    await this.jobModel.updateMany(
      {
        status: 'queued',
        botUserFriendCode: null,
        createdAt: { $lte: queuedDeadline },
      },
      {
        $set: {
          status: 'failed',
          runAt: null,
          error: '排队超时，可能是 Bot 繁忙或异常，请稍后再试',
          updatedAt: now,
        },
      },
    );

    const hardDeadline = new Date(now.getTime() - PROCESSING_HARD_TIMEOUT_MS);
    await this.jobModel.updateMany(
      {
        status: { $in: ['queued', 'processing'] },
        createdAt: { $lte: hardDeadline },
      },
      {
        $set: {
          status: 'failed',
          executing: false,
          runAt: null,
          error: '硬超时：任务存活时间超过 30 分钟',
          updatedAt: now,
        },
      },
    );
  }

  private async enqueueWorkerJob(job: JobEntity): Promise<void> {
    if (['completed', 'failed', 'canceled'].includes(job.status)) return;
    if (job.executing) return;

    const now = Date.now();
    const delay = job.runAt ? Math.max(0, job.runAt.getTime() - now) : 0;
    await this.dxnetQueue.add(
      'dxnet-job',
      { jobId: job.id },
      {
        jobId: job.id,
        delay,
        priority: this.toBullmqPriority(job.priority ?? 0),
      },
    );
  }

  private async promoteOrEnqueueWorkerJob(job: JobEntity): Promise<void> {
    if (['completed', 'failed', 'canceled'].includes(job.status)) return;
    if (job.executing) return;

    const queued = await this.dxnetQueue.getJob(job.id);
    if (queued) {
      const state = await queued.getState();
      if (state === 'delayed') {
        await queued.promote();
      }
      return;
    }

    await this.enqueueWorkerJob(job);
  }

  private toBullmqPriority(priority: number): number | undefined {
    if (!Number.isFinite(priority) || priority <= 0) return undefined;
    return Math.max(1, 100 - Math.floor(priority));
  }

  private async resolveUpdateScoreFriendship(input: {
    friendCode: string;
    botUserFriendCode: string | null;
    friendshipReady: boolean;
  }): Promise<{ ready: boolean; botUserFriendCode: string | null }> {
    if (input.friendshipReady) {
      return {
        ready: true,
        botUserFriendCode: input.botUserFriendCode,
      };
    }

    const availableBots = (await this.botStatus.getAll())
      .filter((bot) => bot.available)
      .sort((a, b) => (a.friendCount ?? 0) - (b.friendCount ?? 0));
    const availableBotCodes = availableBots.map((bot) => bot.friendCode);

    if (input.botUserFriendCode) {
      if (!availableBotCodes.includes(input.botUserFriendCode)) {
        const leastLoadedBot = availableBots[0]?.friendCode ?? null;
        return { ready: false, botUserFriendCode: leastLoadedBot };
      }

      const isFriend = await this.botFriendSnapshot.hasFriend(
        input.botUserFriendCode,
        input.friendCode,
      );
      return {
        ready: isFriend,
        botUserFriendCode: input.botUserFriendCode,
      };
    }

    const botHavingFriend = await this.botFriendSnapshot.findBotHavingFriend(
      input.friendCode,
      availableBotCodes,
    );
    if (botHavingFriend) {
      return { ready: true, botUserFriendCode: botHavingFriend };
    }

    const leastLoadedBot = availableBots[0]?.friendCode ?? null;

    return { ready: false, botUserFriendCode: leastLoadedBot };
  }

  private async resolveCompletedFriendshipProof(input: {
    friendCode: string;
    friendshipJobId?: string;
    now: Date;
  }): Promise<string | null> {
    if (!input.friendshipJobId) return null;

    const proof = await this.jobModel
      .findOne({
        id: input.friendshipJobId,
        friendCode: input.friendCode,
        jobType: 'send_friend_request',
        status: 'completed',
        botUserFriendCode: { $ne: null },
      })
      .lean<JobEntity | null>()
      .exec();

    if (!proof?.botUserFriendCode) {
      throw new BadRequestException({
        code: 'invalid_friendship_proof',
        message: '好友关系验证任务不存在或尚未完成',
      });
    }

    if (
      input.now.getTime() - new Date(proof.updatedAt).getTime() >
      FRIENDSHIP_PROOF_MAX_AGE_MS
    ) {
      throw new BadRequestException({
        code: 'invalid_friendship_proof',
        message: '好友关系验证任务已过期，请重新检查好友状态',
      });
    }

    return proof.botUserFriendCode;
  }

  async getFriendshipStatus(friendCode: string): Promise<{
    isFriend: boolean;
    botFriendCode: string | null;
    recommendedBotFriendCode: string | null;
    availableBotCount: number;
    friendsUpdatedAt: string | null;
    checkedAt: string;
  }> {
    const availableBots = (await this.botStatus.getAll())
      .filter((bot) => bot.available)
      .sort((a, b) => (a.friendCount ?? 0) - (b.friendCount ?? 0));
    const availableBotCodes = availableBots.map((bot) => bot.friendCode);
    const botFriendCode = await this.botFriendSnapshot.findBotHavingFriend(
      friendCode,
      availableBotCodes,
    );
    const snap = botFriendCode
      ? await this.botFriendSnapshot.get(botFriendCode)
      : null;
    const recommendedBotFriendCode =
      botFriendCode ?? availableBots[0]?.friendCode ?? null;

    return {
      isFriend: !!botFriendCode,
      botFriendCode,
      recommendedBotFriendCode,
      availableBotCount: availableBots.length,
      friendsUpdatedAt: snap?.updatedAt?.toISOString() ?? null,
      checkedAt: new Date().toISOString(),
    };
  }

  async create(input: {
    friendCode: string;
    jobType?: JobType;
    friendshipJobId?: string;
    botUserFriendCode?: string | null;
    friendshipReady?: boolean;
    /**
     * Only meaningful when jobType=`update_score`. Set by
     * AutoUpdateScheduler to the score hash it observed; propagates to
     * `user.lastScoreHash` only after this job completes successfully.
     */
    sourceScoreHash?: string | null;
    diffsToScrape?: number[] | null;
    context?: Record<string, unknown> | null;
    cancelActiveJobs?: boolean;
  }) {
    const id = randomUUID();
    const now = new Date();
    let resolvedJobType: JobType = input.jobType ?? 'send_friend_request';

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

    let resolvedStage: JobStage;
    if (resolvedJobType === 'update_score') {
      resolvedStage = 'update_score';
    } else if (resolvedJobType === 'accept_friend_request') {
      resolvedStage = 'wait_user_request';
    } else if (resolvedJobType === 'get_user_recent_event') {
      resolvedStage = 'get_user_recent_event';
    } else if (resolvedJobType === 'get_full_friend_list') {
      resolvedStage = 'get_full_friend_list';
    } else {
      resolvedStage = 'send_request';
    }

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
      try {
        const user = await this.usersService.findByFriendCode(input.friendCode);
        const userCabinetUid = (
          user as { cabinetUserId?: number | null } | null
        )?.cabinetUserId;
        if (userCabinetUid != null) {
          let botCabinetUid: number | null = null;
          let botFc: string | null = input.botUserFriendCode ?? null;
          if (botFc) {
            const allBots = await this.botStatus.getAll();
            const bot = allBots.find((b) => b.friendCode === botFc);
            botCabinetUid = bot?.cabinetUserId ?? null;
          } else {
            const picked = await this.botStatus.pickAvailableCabinetBot();
            if (picked) {
              botFc = picked.friendCode;
              botCabinetUid = picked.cabinetUserId ?? null;
              input.botUserFriendCode = botFc;
            }
          }

          if (botCabinetUid != null && botFc) {
            try {
              const r = await this.sdgb.addRival(
                {
                  botCabinetUserId: botCabinetUid,
                  targetCabinetUserId: userCabinetUid,
                },
                {
                  tag: `score-update-add:${input.friendCode}`,
                  timeoutMs: 60_000,
                },
              );
              resolvedStage = 'update_score';
              input.friendshipReady = true;
              this.logger.log(
                `Cabinet fast-path fc=${input.friendCode} bot=${botFc} addRival rc=${r.returnCode1}/${r.returnCode2}`,
              );
            } catch (err) {
              this.logger.warn(
                `Cabinet fast-path addRival failed for fc=${input.friendCode}; needs explicit friendship job: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }
      } catch (err) {
        // Lookup failure is non-fatal — fall back to original send_request flow.
        this.logger.warn(
          `cabinet-bound fast-path lookup failed for ${input.friendCode}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (resolvedJobType === 'update_score') {
      const friendship = await this.resolveUpdateScoreFriendship({
        friendCode: input.friendCode,
        botUserFriendCode: input.botUserFriendCode ?? null,
        friendshipReady: input.friendshipReady ?? false,
      });

      if (friendship.ready) {
        input.botUserFriendCode = friendship.botUserFriendCode;
        resolvedStage = 'update_score';
      } else {
        const proofBotFriendCode = await this.resolveCompletedFriendshipProof({
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
            executing: false,
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
      executing: false,
      error: null,
      result: undefined,
      sourceScoreHash: input.sourceScoreHash ?? null,
      diffsToScrape: input.diffsToScrape ?? null,
      context: input.context ?? null,
      runAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const createdEntity = created.toObject() as JobEntity;
    await this.enqueueWorkerJob(createdEntity);
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

    if (!updated) throw new NotFoundException('Job not found');

    await this.promoteOrEnqueueWorkerJob(updated.toObject() as JobEntity);
    return toJobResponse(updated.toObject() as JobEntity);
  }

  async patch(jobId: string, body: JobPatchBody): Promise<JobResponse> {
    const update: Partial<JobEntity> = {};
    const additionalOps: Record<string, unknown> = {};
    const finalStatuses: JobStatus[] = ['completed', 'failed', 'canceled'];
    const existing = await this.jobModel.findOne({ id: jobId }).lean();
    if (!existing) {
      throw new NotFoundException('Job not found');
    }

    if (body.botUserFriendCode !== undefined) {
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

    if (body.status !== undefined) {
      if (!VALID_STATUS.includes(body.status)) {
        throw new BadRequestException('Invalid status value');
      }
      update.status = body.status;
    }

    if (body.stage !== undefined) {
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

    if (body.result !== undefined) {
      update.result = body.result;
    }

    if (body.profile !== undefined) {
      update.profile = body.profile;
    }

    if (body.error !== undefined) {
      if (body.error !== null && typeof body.error !== 'string') {
        throw new BadRequestException('error must be a string or null');
      }
      update.error = body.error;
    }

    if (body.friendRequestSentAt !== undefined) {
      if (
        body.friendRequestSentAt !== null &&
        typeof body.friendRequestSentAt !== 'string'
      ) {
        throw new BadRequestException(
          'friendRequestSentAt must be a string or null',
        );
      }
      update.friendRequestSentAt = body.friendRequestSentAt;
    }

    if (body.friendRequestWaitStartedAt !== undefined) {
      if (
        body.friendRequestWaitStartedAt !== null &&
        typeof body.friendRequestWaitStartedAt !== 'string'
      ) {
        throw new BadRequestException(
          'friendRequestWaitStartedAt must be a string or null',
        );
      }
      update.friendRequestWaitStartedAt = body.friendRequestWaitStartedAt;
    }

    if (body.executing !== undefined) {
      if (typeof body.executing !== 'boolean') {
        throw new BadRequestException('executing must be a boolean');
      }
      update.executing = body.executing;
    }

    if (body.runAt !== undefined) {
      if (body.runAt === null) {
        update.runAt = null;
      } else {
        if (typeof body.runAt !== 'string') {
          throw new BadRequestException('runAt must be an ISO string or null');
        }
        const parsed = new Date(body.runAt);
        if (Number.isNaN(parsed.getTime())) {
          throw new BadRequestException('runAt must be a valid ISO date');
        }
        update.runAt = parsed;
      }
    }

    if (body.updatedAt !== undefined) {
      if (typeof body.updatedAt !== 'string') {
        throw new BadRequestException('updatedAt must be an ISO string');
      }
      const parsed = new Date(body.updatedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('updatedAt must be a valid ISO date');
      }
      update.updatedAt = parsed;
    } else {
      update.updatedAt = new Date();
    }

    // 处理 updateScoreDuration
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

    // 处理 scoreProgress：完整替换模式
    if (body.scoreProgress !== undefined) {
      update.scoreProgress = body.scoreProgress;
    }

    // 处理 addCompletedDiff：原子追加模式（使用 $addToSet 避免并发冲突）
    if (body.addCompletedDiff !== undefined) {
      if (typeof body.addCompletedDiff !== 'number') {
        throw new BadRequestException('addCompletedDiff must be a number');
      }
      additionalOps.$addToSet = {
        'scoreProgress.completedDiffs': body.addCompletedDiff,
      };
    }

    if (body.status && finalStatuses.includes(body.status)) {
      update.runAt = null;
    }

    // 构建更新操作
    const updateOps: Record<string, unknown> = {
      $set: update,
      ...additionalOps,
    };

    const updated = await this.jobModel.findOneAndUpdate(
      { id: jobId },
      updateOps,
      { new: true },
    );

    if (!updated) throw new NotFoundException('Job not found');

    // 当 job 完成、失败或取消时，清理临时缓存
    if (finalStatuses.includes(updated.status)) {
      // 异步清理缓存，不阻塞响应
      this.tempCacheService.deleteByJobId(jobId).catch((err) => {
        console.error(`Failed to delete temp cache for job ${jobId}:`, err);
      });
    }

    if (
      updated.status === 'completed' &&
      updated.jobType === 'update_score' &&
      updated.result
    ) {
      await this.syncService.createFromJob(updated.toObject() as JobEntity);

      // Auto-export is fire-and-forget. Worker may PATCH a completed job
      // multiple times (e.g. retried bookkeeping update), and each PATCH
      // hits this branch — without the autoExportResult guard we'd
      // re-run the export every time, hammering diving-fish/lxns.
      // Use atomic findOneAndUpdate so concurrent patches in the same
      // backend replica race only one winner.
      const claimed = await this.jobModel
        .findOneAndUpdate(
          { id: jobId, autoExportResult: null },
          { $set: { autoExportResult: { divingFish: null, lxns: null } } },
          { new: true },
        )
        .exec();
      if (claimed) {
        this.runAutoExport(jobId, updated.friendCode).catch((err: Error) => {
          this.logger.error(
            `Auto-export failed for job ${jobId}: ${err?.message}`,
          );
        });
      }
    }

    if (
      updated.status === 'completed' &&
      updated.jobType === 'get_user_recent_event' &&
      updated.result
    ) {
      const events = (updated.result as { events?: unknown }).events;
      if (Array.isArray(events)) {
        const context = updated.context ?? null;
        const sinceRaw =
          typeof context?.recentEventSince === 'string'
            ? context.recentEventSince
            : null;
        const since = sinceRaw ? new Date(sinceRaw) : null;
        const mergeResult = await this.syncService.mergeRecentEvents({
          friendCode: updated.friendCode,
          sourceId: jobId,
          events,
          since: since && !Number.isNaN(since.getTime()) ? since : null,
        });
        if (
          context?.autoUpdateFcfs === true &&
          mergeResult.ambiguousDiffs.length > 0 &&
          updated.botUserFriendCode
        ) {
          const fallback = await this.create({
            friendCode: updated.friendCode,
            jobType: 'update_score',
            botUserFriendCode: updated.botUserFriendCode,
            friendshipReady: true,
            diffsToScrape: mergeResult.ambiguousDiffs,
            cancelActiveJobs: false,
            context: {
              source: 'fcfs_ambiguous_recent_event',
              recentEventJobId: jobId,
              ambiguousDiffs: mergeResult.ambiguousDiffs,
            },
          });
          this.logger.log(
            `Scheduled ambiguous FC/FS fallback update_score job ${fallback.jobId} for fc=${updated.friendCode} diffs=[${mergeResult.ambiguousDiffs.join(',')}]`,
          );
        }
      }
    }

    // Auto-update bookkeeping: sourceScoreHash marks update_score jobs
    // launched by AutoUpdateScheduler.
    //
    // - completed: promote sourceScoreHash to user.lastScoreHash AND
    //   clear backoff (failureCount=0, backoffUntil=null). We
    //   deliberately wait for completion so a failed/canceled job
    //   does not "burn" the hash transition — the next sweep should
    //   see the same diff and try again.
    // - failed: bump autoUpdateFailureCount and set
    //   autoUpdateBackoffUntil = now + base * factor^(count-1) capped.
    //   This pushes persistently-failing users out of the bot queue
    //   so healthy users aren't drowned out.
    // - canceled: clear backoff too. A scheduler-created job almost
    //   always gets canceled because the user triggered a manual sync
    //   (JobService.create's "cancel older for same friendCode" rule),
    //   which means the user's cookies are healthy and we should NOT
    //   leave them stuck in exponential backoff. Hash promotion
    //   intentionally stays gated on `completed` — a canceled job
    //   didn't necessarily scrape anything, so lastScoreHash must
    //   stay as-is for the next sweep to retry.
    if (updated.sourceScoreHash) {
      if (
        updated.jobType === 'update_score' &&
        updated.status === 'completed'
      ) {
        this.usersService
          .findByFriendCode(updated.friendCode)
          .then(async (user) => {
            if (!user) return;
            await this.usersService.update(String(user._id), {
              lastScoreHash: updated.sourceScoreHash,
            });
            await this.usersService.resetAutoUpdateBackoff(String(user._id));
          })
          .catch((err: Error) => {
            this.logger.warn(
              `Failed to promote sourceScoreHash for job ${jobId}: ${err?.message}`,
            );
          });
      } else if (updated.status === 'failed') {
        this.usersService
          .findByFriendCode(updated.friendCode)
          .then(async (user) => {
            if (!user) return;
            const result = await this.usersService.recordAutoUpdateFailure(
              String(user._id),
              AUTO_UPDATE_BACKOFF_POLICY,
            );
            if (result) {
              this.logger.warn(
                `auto-update fc=${updated.friendCode} job ${jobId} failed; ` +
                  `failureCount=${result.failureCount} backoffUntil=${result.backoffUntil.toISOString()}`,
              );
            }
          })
          .catch((err: Error) => {
            this.logger.warn(
              `Failed to record auto-update failure for job ${jobId}: ${err?.message}`,
            );
          });
      } else if (updated.status === 'canceled') {
        this.usersService
          .findByFriendCode(updated.friendCode)
          .then(async (user) => {
            if (!user) return;
            await this.usersService.resetAutoUpdateBackoff(String(user._id));
          })
          .catch((err: Error) => {
            this.logger.warn(
              `Failed to reset auto-update backoff for canceled job ${jobId}: ${err?.message}`,
            );
          });
      }
    }

    return toJobResponse(updated.toObject() as JobEntity);
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

  /**
   * 自动导出：检查用户设置，异步导出到 diving-fish / lxns，
   * 完成后将结果写回 job.autoExportResult
   */
  private async runAutoExport(
    jobId: string,
    friendCode: string,
  ): Promise<void> {
    const user = await this.usersService.findByFriendCode(friendCode);
    if (!user) return;

    const userDoc = user as unknown as Record<string, unknown>;
    const shouldExportDf =
      !!userDoc.autoExportDivingFish && !!user.divingFishImportToken;
    const shouldExportLxns = !!userDoc.autoExportLxns && !!user.lxnsImportToken;

    if (!shouldExportDf && !shouldExportLxns) return;

    const exportResult: {
      divingFish?: { status: string; message?: string } | null;
      lxns?: { status: string; message?: string } | null;
    } = {};

    if (shouldExportDf) {
      try {
        const res = await this.syncService.exportToDivingFish(
          friendCode,
          user.divingFishImportToken!,
        );
        exportResult.divingFish = {
          status: 'success',
          message: `导出 ${res.exported ?? 0} 条成绩`,
        };
        this.logger.log(`Auto-export to DivingFish succeeded for job ${jobId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        exportResult.divingFish = { status: 'failed', message: msg };
        this.logger.warn(
          `Auto-export to DivingFish failed for job ${jobId}: ${msg}`,
        );
      }
    }

    if (shouldExportLxns) {
      try {
        const res = await this.syncService.exportToLxns(
          friendCode,
          user.lxnsImportToken!,
        );
        exportResult.lxns = {
          status: 'success',
          message: `导出 ${res.exported ?? 0} 条成绩`,
        };
        this.logger.log(`Auto-export to LXNS succeeded for job ${jobId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        exportResult.lxns = { status: 'failed', message: msg };
        this.logger.warn(`Auto-export to LXNS failed for job ${jobId}: ${msg}`);
      }
    }

    // Write results back to the job document and the sync record
    await Promise.all([
      this.jobModel.updateOne(
        { id: jobId },
        { $set: { autoExportResult: exportResult } },
      ),

      this.syncService.updateAutoExportResult(jobId, exportResult),
    ]);
  }
}
