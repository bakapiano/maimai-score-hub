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
import { Queue, QueueEvents } from 'bullmq';

import { SyncService } from '../../sync/services/sync.service';
import { UsersService } from '../../users/services/users.service';
import { JobTempCacheService } from '../cache/temp-cache.service';
import { ProberExportService } from '../../prober-export/services/prober-export.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { BotFriendSnapshotService } from '../../bots/services/bot-friend-snapshot.service';
import { BotStatusService } from '../../bots/services/bot-status.service';
import type {
  JobPatchBody,
  JobResponse,
  JobStage,
  JobStatus,
  JobType,
} from '../job.types';
import {
  getDxnetWorkerQueueName,
  getJobTypePriority,
} from '@maimai-score-hub/shared';
import { JobEntity } from '../schemas/job.schema';
import {
  DEFAULT_WORKER_JOB_OPTIONS,
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

const FRIENDSHIP_PROOF_MAX_AGE_MS = 10 * 60 * 1000;
const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'canceled',
] as const;

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
    removeFriendAfterComplete: job.removeFriendAfterComplete ?? false,
    runAt: job.runAt?.toISOString() ?? null,
    error: job.error ?? null,
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
  private readonly queueOptions: ReturnType<typeof createBullmqQueueOptions>;
  private readonly dxnetQueues = new Map<string, Queue<DxnetWorkerJobData>>();
  private readonly dxnetQueueEvents = new Map<string, QueueEvents>();

  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobModel: Model<JobEntity>,
    private readonly syncService: SyncService,
    private readonly tempCacheService: JobTempCacheService,
    private readonly proberExports: ProberExportService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly sdgb: SdgbJobDispatcher,
    private readonly botFriendSnapshot: BotFriendSnapshotService,
    @Inject(forwardRef(() => BotStatusService))
    private readonly botStatus: BotStatusService,
    config: ConfigService,
  ) {
    this.queueOptions = createBullmqQueueOptions(config);
  }

  async onModuleInit(): Promise<void> {
    try {
      const bots = await this.botStatus.getAll();
      for (const bot of bots) {
        this.ensureDxnetQueueEvents(getDxnetWorkerQueueName(bot.friendCode));
      }
    } catch (err) {
      this.logger.warn(
        `failed to initialize dxnet queue events: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      ...[...this.dxnetQueues.values()].map((queue) => queue.close()),
      ...[...this.dxnetQueueEvents.values()].map((events) => events.close()),
    ]);
  }

  private async enqueueWorkerJob(job: JobEntity): Promise<void> {
    if (TERMINAL_STATUSES.includes(job.status)) return;
    if (!job.botUserFriendCode) {
      throw new Error(`DXNet job ${job.id} has no botUserFriendCode`);
    }

    const now = Date.now();
    const delay = job.runAt ? Math.max(0, job.runAt.getTime() - now) : 0;
    await this.getDxnetQueue(job.botUserFriendCode).add(
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
    if (TERMINAL_STATUSES.includes(job.status)) return;
    if (!job.botUserFriendCode) {
      throw new Error(`DXNet job ${job.id} has no botUserFriendCode`);
    }

    const queue = this.getDxnetQueue(job.botUserFriendCode);
    const queued = await queue.getJob(job.id);
    if (queued) {
      const state = await queued.getState();
      if (state === 'delayed') {
        await queued.promote();
      }
      return;
    }

    await this.enqueueWorkerJob(job);
  }

  private getDxnetQueue(botFriendCode: string): Queue<DxnetWorkerJobData> {
    const queueName = getDxnetWorkerQueueName(botFriendCode);
    const existing = this.dxnetQueues.get(queueName);
    if (existing) return existing;

    const queue = new Queue<DxnetWorkerJobData>(queueName, {
      ...this.queueOptions,
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
    this.dxnetQueues.set(queueName, queue);
    this.ensureDxnetQueueEvents(queueName);
    return queue;
  }

  private ensureDxnetQueueEvents(queueName: string): void {
    if (this.dxnetQueueEvents.has(queueName)) return;

    const events = new QueueEvents(queueName, this.queueOptions);
    events.on('failed', ({ jobId, failedReason }) => {
      if (!jobId) return;
      this.markBullmqJobFailed(jobId, failedReason).catch((err) => {
        this.logger.warn(
          `failed to mirror BullMQ failure for ${queueName}/${jobId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
    });
    events.on('stalled', ({ jobId }) => {
      this.logger.warn(
        `DXNet BullMQ job stalled queue=${queueName} job=${jobId}`,
      );
    });
    events.on('error', (err) => {
      this.logger.warn(
        `DXNet BullMQ queue events error queue=${queueName}: ${err.message}`,
      );
    });
    this.dxnetQueueEvents.set(queueName, events);
  }

  private async markBullmqJobFailed(
    jobId: string,
    failedReason?: string,
  ): Promise<void> {
    await this.jobModel.updateOne(
      { id: jobId, status: { $nin: TERMINAL_STATUSES } },
      {
        $set: {
          status: 'failed',
          runAt: null,
          error: failedReason || 'BullMQ job failed',
          updatedAt: new Date(),
        },
      },
    );
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
    if (input.friendshipReady && input.botUserFriendCode) {
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

  private async resolveBotForCreate(input: {
    friendCode: string;
    jobType: JobType;
    botUserFriendCode: string | null;
  }): Promise<string> {
    if (input.botUserFriendCode) {
      return input.botUserFriendCode;
    }

    if (
      input.jobType === 'send_friend_request' ||
      input.jobType === 'accept_friend_request'
    ) {
      const picked = await this.botStatus.pickAvailableBot();
      if (!picked) {
        throw new BadRequestException('当前没有可用的 Bot');
      }
      return picked.friendCode;
    }

    if (input.jobType === 'get_full_friend_list') {
      return input.friendCode;
    }

    throw new BadRequestException(
      `jobType ${input.jobType} requires botUserFriendCode`,
    );
  }

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

    input.botUserFriendCode = await this.resolveBotForCreate({
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
      const sync = await this.syncService.createFromJob(
        updated.toObject() as JobEntity,
      );
      if (sync?.id) {
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
          mergeResult.updatedCount > 0 &&
          mergeResult.syncId
        ) {
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
            removeFriendAfterComplete: true,
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
          updated.removeFriendAfterComplete = false;
          await this.jobModel.updateOne(
            { id: jobId },
            { $set: { removeFriendAfterComplete: false } },
          );
        }
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
}
