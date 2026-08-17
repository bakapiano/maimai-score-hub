/* eslint-disable max-lines */
import {
  BadRequestException,
  ConflictException,
  GoneException,
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
import {
  getDxnetDeadlineAt,
  getDxnetRouteDefinition,
  inferDxnetJobSource,
  type DxnetJobSource,
  type DxnetRoutingControl,
  type DxnetRouteDefinition,
  getDxnetPinnedQueueName,
  getDxnetSharedQueueName,
} from '@maimai-score-hub/shared';
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
import { toJobResponse, toWorkerJobResponse } from './job-response.mapper';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { DxnetRoutingControlService } from './dxnet-routing-control.service';
import { DxnetAssignmentMutexService } from './dxnet-assignment-mutex.service';
import { DxnetBotAssignmentBusyException } from '../dxnet-job.exceptions';
import type { BotStatus } from '../../bots/services/bot-status.service';

export interface CreateDxnetJobInput {
  friendCode: string;
  jobType?: JobType;
  source?: DxnetJobSource;
  friendshipJobId?: string;
  botUserFriendCode?: string | null;
  diffsToScrape?: number[] | null;
  context?: Record<string, unknown> | null;
  cancelActiveJobs?: boolean;
  runAt?: Date | string | null;
}

type CabinetStatus =
  | 'not_required'
  | 'pending'
  | 'running'
  | 'ready'
  | 'uncertain'
  | 'failed';

type V2Assignment = {
  assignmentMode: 'claim' | 'pinned';
  botUserFriendCode: string | null;
  cabinetStatus: CabinetStatus;
};

const COMPLETION_GRACE_MS = 5 * 60_000;

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
    private readonly botStatus: BotStatusService,
    private readonly routingControl: DxnetRoutingControlService,
    private readonly assignmentMutex: DxnetAssignmentMutexService,
  ) {}

  async create(input: CreateDxnetJobInput) {
    const control = await this.routingControl.get();
    return this.createV2({ ...input }, control);
  }

  async createIdentityResolution(input: {
    jobId: string;
    attemptId: string;
    source: 'qr_login' | 'cabinet_binding';
  }): Promise<{ jobId: string }> {
    const control = await this.routingControl.get();
    if (!this.routingControl.isClaimFlowEnabled(control, 'qr_identity', null)) {
      throw new BadRequestException('QR identity claim flow is not enabled');
    }
    const id = input.jobId;
    const now = new Date();
    const definition = getDxnetRouteDefinition(
      input.source,
      'get_full_friend_list',
    );
    const created = await this.jobModel.create({
      id,
      friendCode: null,
      jobType: 'get_full_friend_list',
      priority: definition.priority,
      routing: {
        version: 2,
        deliveryEpoch: 1,
        source: input.source,
        lane: definition.lane,
        assignmentMode: 'claim',
        deliveryMode: 'shared',
      },
      execution: null,
      cabinetFriendship: {
        status: 'pending',
        botFriendCode: null,
        deliveryEpoch: null,
        attemptsStarted: null,
        sdgbJobId: null,
        lastError: null,
      },
      deadlineAt: getDxnetDeadlineAt(definition.lane, now),
      errorCode: null,
      botUserFriendCode: null,
      friendRequestSentAt: null,
      friendRequestWaitStartedAt: null,
      status: 'queued',
      stage: 'get_full_friend_list',
      error: null,
      context: {
        purpose:
          input.source === 'qr_login'
            ? 'qr_login_resolution'
            : 'cabinet_binding_resolution',
        identityAttemptId: input.attemptId,
      },
      runAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const entity = created.toObject() as JobEntity;
    try {
      await this.jobQueue.enqueueWorkerJob(entity);
    } catch (error) {
      await this.jobModel.updateOne(
        { id, status: 'queued' },
        {
          $set: {
            status: 'failed',
            error: `failed to enqueue identity job: ${errorMessage(error)}`,
            updatedAt: new Date(),
          },
        },
      );
      throw error;
    }
    return { jobId: id };
  }

  private async createV2(
    input: CreateDxnetJobInput,
    control: DxnetRoutingControl,
  ) {
    const id = randomUUID();
    const now = new Date();
    const jobType: JobType = input.jobType ?? 'send_friend_request';
    const source =
      input.source ?? inferDxnetJobSource(jobType, input.context ?? null);
    const definition = getDxnetRouteDefinition(source, jobType);

    const healthyBots = await this.botStatus.getHealthyBots(
      control.botAllowlist,
    );
    const { assignmentMode, botUserFriendCode, cabinetStatus } =
      await this.resolveV2Assignment({
        input,
        jobType,
        source,
        definition,
        control,
        healthyBots,
        now,
      });

    if (assignmentMode === 'pinned' && !botUserFriendCode) {
      throw new BadRequestException(`v2 pinned ${jobType} requires a Bot`);
    }
    const relationshipOwning =
      jobType === 'send_friend_request' ||
      jobType === 'accept_friend_request' ||
      cabinetStatus !== 'not_required';
    const persist = () =>
      this.persistV2Job({
        id,
        now,
        input,
        jobType,
        source,
        lane: definition.lane,
        priority: definition.priority,
        assignmentMode,
        botUserFriendCode,
        cabinetStatus,
      });

    if (relationshipOwning && botUserFriendCode) {
      const result = await this.assignmentMutex.run(
        botUserFriendCode,
        async ({ assertActive }) => {
          assertActive();
          await this.assertEffectiveFriendCapacity(botUserFriendCode, id);
          assertActive();
          return persist();
        },
      );
      if (!result.acquired) {
        throw new DxnetBotAssignmentBusyException();
      }
      return result.value;
    }
    return persist();
  }

  private async resolveV2Assignment(input: {
    input: CreateDxnetJobInput;
    jobType: JobType;
    source: DxnetJobSource;
    definition: DxnetRouteDefinition;
    control: DxnetRoutingControl;
    healthyBots: BotStatus[];
    now: Date;
  }): Promise<V2Assignment> {
    if (input.jobType === 'update_score') {
      return this.resolveV2UpdateScore(input);
    }
    if (input.jobType === 'get_user_recent_event') {
      return this.resolveV2RecentEvent(input);
    }
    if (
      input.jobType === 'send_friend_request' ||
      input.jobType === 'accept_friend_request'
    ) {
      return this.resolveV2FriendInteraction(
        input.input,
        input.healthyBots,
        input.now,
      );
    }
    return this.resolveV2FullFriendList(input.input, input.healthyBots);
  }

  private async resolveV2UpdateScore(input: {
    input: CreateDxnetJobInput;
    source: DxnetJobSource;
    definition: DxnetRouteDefinition;
    control: DxnetRoutingControl;
    healthyBots: BotStatus[];
    now: Date;
  }): Promise<V2Assignment> {
    const requestedBot = input.input.botUserFriendCode ?? null;
    const healthyCodes = input.healthyBots.map((bot) => bot.friendCode);
    const freshBot = await this.friendship.resolveFreshSnapshotBot({
      friendCode: input.input.friendCode,
      botFriendCodes: requestedBot
        ? healthyCodes.filter((code) => code === requestedBot)
        : healthyCodes,
      now: input.now,
    });
    const proofBot = await this.resolveV2ProofBot(
      input.input,
      freshBot,
      healthyCodes,
      input.now,
    );
    if (freshBot || proofBot) {
      return {
        assignmentMode: 'pinned',
        botUserFriendCode: freshBot ?? proofBot,
        cabinetStatus: 'not_required',
      };
    }
    return this.resolveV2CabinetUpdate(input);
  }

  private async resolveV2ProofBot(
    input: CreateDxnetJobInput,
    freshBot: string | null,
    healthyCodes: string[],
    now: Date,
  ): Promise<string | null> {
    if (freshBot || !input.friendshipJobId) {
      return null;
    }
    const proof = await this.friendship.resolveCompletedFriendshipProof({
      friendCode: input.friendCode,
      friendshipJobId: input.friendshipJobId,
      now,
    });
    return proof && healthyCodes.includes(proof) ? proof : null;
  }

  private async resolveV2CabinetUpdate(input: {
    input: CreateDxnetJobInput;
    source: DxnetJobSource;
    definition: DxnetRouteDefinition;
    control: DxnetRoutingControl;
    healthyBots: BotStatus[];
    now: Date;
  }): Promise<V2Assignment> {
    const cabinetUserId = await this.friendship.getTargetCabinetUserId(
      input.input.friendCode,
    );
    const useClaim =
      input.source === 'auto_update' ||
      this.routingControl.isClaimFlowEnabled(
        input.control,
        input.definition.claimFlow,
        input.input.friendCode,
      );
    if (useClaim && cabinetUserId !== null) {
      return {
        assignmentMode: 'claim',
        botUserFriendCode: null,
        cabinetStatus: 'pending',
      };
    }
    const pinned = this.pickPinnedCabinetBot(input, cabinetUserId);
    if (pinned) {
      return {
        assignmentMode: 'pinned',
        botUserFriendCode: pinned,
        cabinetStatus: 'pending',
      };
    }
    throw new BadRequestException({
      code: 'needs_friendship',
      message: '请先让当前账号与可用 Bot 成为好友后再更新成绩',
      recommendedBotFriendCode:
        input.healthyBots
          .filter((bot) => this.hasFreshRelationshipCapacity(bot, input.now))
          .sort(byFriendCount)[0]?.friendCode ?? null,
    });
  }

  private pickPinnedCabinetBot(
    input: {
      input: CreateDxnetJobInput;
      healthyBots: BotStatus[];
      now: Date;
    },
    cabinetUserId: number | null,
  ): string | null {
    if (cabinetUserId === null) {
      return null;
    }
    const candidate = input.healthyBots
      .filter(
        (bot) =>
          bot.cabinetUserId !== null &&
          this.hasFreshRelationshipCapacity(bot, input.now),
      )
      .sort(byFriendCount)[0];
    if (!candidate) {
      return null;
    }
    return candidate.friendCode;
  }

  private async resolveV2RecentEvent(input: {
    input: CreateDxnetJobInput;
    definition: DxnetRouteDefinition;
    control: DxnetRoutingControl;
    healthyBots: BotStatus[];
  }): Promise<V2Assignment> {
    const claimEnabled = this.routingControl.isClaimFlowEnabled(
      input.control,
      input.definition.claimFlow,
      input.input.friendCode,
    );
    if (claimEnabled) {
      if (
        (await this.friendship.getTargetCabinetUserId(
          input.input.friendCode,
        )) === null
      ) {
        throw new BadRequestException('cabinetUserId is required');
      }
      return {
        assignmentMode: 'claim',
        botUserFriendCode: null,
        cabinetStatus: 'pending',
      };
    }
    const bot = input.input.botUserFriendCode ?? null;
    if (
      !bot ||
      !input.healthyBots.some((candidate) => candidate.friendCode === bot)
    ) {
      throw new BadRequestException(
        'get_user_recent_event requires a healthy v2 pinned bot while claim flow is disabled',
      );
    }
    return {
      assignmentMode: 'pinned',
      botUserFriendCode: bot,
      cabinetStatus: 'not_required',
    };
  }

  private resolveV2FriendInteraction(
    input: CreateDxnetJobInput,
    healthyBots: BotStatus[],
    now: Date,
  ): V2Assignment {
    const requested = input.botUserFriendCode
      ? healthyBots.find((bot) => bot.friendCode === input.botUserFriendCode)
      : null;
    const picked =
      requested ??
      healthyBots
        .filter((bot) => this.hasFreshRelationshipCapacity(bot, now))
        .sort(byFriendCount)[0];
    if (!picked || !this.hasFreshRelationshipCapacity(picked, now)) {
      throw new BadRequestException({
        code: 'cabinet_bot_unavailable',
        message: '当前没有具备好友容量的 v2 Bot',
      });
    }
    return {
      assignmentMode: 'pinned',
      botUserFriendCode: picked.friendCode,
      cabinetStatus: 'not_required',
    };
  }

  private resolveV2FullFriendList(
    input: CreateDxnetJobInput,
    healthyBots: BotStatus[],
  ): V2Assignment {
    const bot = input.botUserFriendCode ?? input.friendCode;
    if (!healthyBots.some((candidate) => candidate.friendCode === bot)) {
      throw new BadRequestException(
        'full friend-list refresh requires a healthy v2 Bot',
      );
    }
    return {
      assignmentMode: 'pinned',
      botUserFriendCode: bot,
      cabinetStatus: 'not_required',
    };
  }

  private async persistV2Job(input: {
    id: string;
    now: Date;
    input: CreateDxnetJobInput;
    jobType: JobType;
    source: DxnetJobSource;
    lane: 'interactive' | 'user_sync' | 'background';
    priority: number;
    assignmentMode: 'claim' | 'pinned';
    botUserFriendCode: string | null;
    cabinetStatus:
      | 'not_required'
      | 'pending'
      | 'running'
      | 'ready'
      | 'uncertain'
      | 'failed';
  }) {
    const runAt =
      input.input.runAt === undefined || input.input.runAt === null
        ? null
        : input.input.runAt instanceof Date
          ? input.input.runAt
          : this.parseIsoDate(input.input.runAt, 'runAt');
    if (input.input.cancelActiveJobs !== false) {
      await this.jobModel.updateMany(
        {
          friendCode: input.input.friendCode,
          status: { $nin: ['completed', 'failed', 'canceled'] },
          completionPending: { $ne: true },
        },
        {
          $set: { status: 'canceled', runAt: null, updatedAt: input.now },
        },
      );
    }
    const created = await this.jobModel.create({
      id: input.id,
      friendCode: input.input.friendCode,
      jobType: input.jobType,
      priority: input.priority,
      routing: {
        version: 2,
        deliveryEpoch: 1,
        source: input.source,
        lane: input.lane,
        assignmentMode: input.assignmentMode,
        deliveryMode: input.assignmentMode === 'claim' ? 'shared' : 'pinned',
      },
      execution: null,
      cabinetFriendship: {
        status: input.cabinetStatus,
        botFriendCode: input.botUserFriendCode,
        deliveryEpoch: null,
        attemptsStarted: null,
        sdgbJobId: null,
        lastError: null,
      },
      deadlineAt: getDxnetDeadlineAt(input.lane, input.now),
      errorCode: null,
      completionPending: false,
      botUserFriendCode: input.botUserFriendCode,
      friendRequestSentAt: null,
      friendRequestWaitStartedAt:
        input.jobType === 'accept_friend_request'
          ? input.now.toISOString()
          : null,
      status: 'queued',
      stage: initialStageForJobType(input.jobType),
      error: null,
      result: undefined,
      diffsToScrape: input.input.diffsToScrape ?? null,
      context: input.input.context ?? null,
      runAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
    const entity = created.toObject() as JobEntity;
    try {
      await this.jobQueue.enqueueWorkerJob(entity);
    } catch (error) {
      await this.jobModel.updateOne(
        { id: input.id, status: 'queued' },
        {
          $set: {
            status: 'failed',
            runAt: null,
            error: `failed to enqueue dxnet BullMQ job: ${error instanceof Error ? error.message : String(error)}`,
            updatedAt: new Date(),
          },
        },
      );
      throw error;
    }
    this.observability.recordJobTimelineEvent({
      ts: input.now,
      jobId: input.id,
      jobKind: 'dxnet',
      jobType: input.jobType,
      eventName: 'route_selected',
      toStatus: 'queued',
      toStage: entity.stage,
      botFriendCode: input.botUserFriendCode,
      attrs: {
        source: input.source,
        lane: input.lane,
        assignmentMode: input.assignmentMode,
        priority: input.priority,
        deliveryEpoch: 1,
      },
    });
    return { jobId: input.id, job: toJobResponse(entity) };
  }

  private hasFreshRelationshipCapacity(
    bot: { friendCount: number | null; friendsUpdatedAt: string | null },
    now: Date,
  ): boolean {
    return (
      bot.friendCount !== null &&
      bot.friendCount < 50 &&
      !!bot.friendsUpdatedAt &&
      new Date(bot.friendsUpdatedAt).getTime() >= now.getTime() - 5 * 60_000
    );
  }

  private async assertEffectiveFriendCapacity(
    botFriendCode: string,
    currentJobId: string,
    workerAssignment = false,
  ): Promise<void> {
    const bot = await this.botStatus.getByFriendCode(botFriendCode);
    if (!bot || bot.friendCount === null) {
      if (workerAssignment) {
        throw botIneligible('capacity');
      }
      throw new BadRequestException({
        code: 'cabinet_bot_unavailable',
        message: 'Bot friend snapshot is unavailable',
      });
    }
    const owningJobs = await this.jobModel.countDocuments({
      id: { $ne: currentJobId },
      'routing.version': 2,
      botUserFriendCode: botFriendCode,
      status: { $nin: ['completed', 'failed', 'canceled'] },
      $or: [
        { jobType: { $in: ['send_friend_request', 'accept_friend_request'] } },
        { 'cabinetFriendship.status': { $ne: 'not_required' } },
      ],
    });
    const prospectiveLoad = bot.friendCount + owningJobs + 1;
    if (prospectiveLoad >= 80) {
      if (workerAssignment) {
        throw botIneligible('capacity');
      }
      throw new BadRequestException({
        code: 'cabinet_bot_unavailable',
        message: 'Bot friend capacity is exhausted',
      });
    }
  }

  async get(jobId: string): Promise<JobResponse> {
    const job = await this.jobModel.findOne({ id: jobId });
    if (!job || !job.friendCode) {
      throw new NotFoundException('Job not found');
    }
    return toJobResponse(job.toObject() as JobEntity);
  }

  async getWorker(jobId: string) {
    const job = await this.jobModel.findOne({ id: jobId });
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    return toWorkerJobResponse(job.toObject() as JobEntity);
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

  async patch(jobId: string, body: JobPatchBody) {
    const existing = await this.jobModel.findOne({ id: jobId }).lean();
    if (!existing) {
      throw new NotFoundException('Job not found');
    }
    if ((existing as JobEntity).routing?.version !== 2) {
      throw new ConflictException({
        code: 'invalid_route',
        message: 'DXNet job is missing routing v2 metadata',
      });
    }
    return this.patchV2(existing as JobEntity, body);
  }

  private async patchV2(existing: JobEntity, body: JobPatchBody) {
    const execution = body.execution;
    if (!execution) {
      throw new ConflictException({
        code: 'stale_execution',
        message: 'routing v2 PATCH requires execution generation',
      });
    }
    this.assertV2JobMayMutate(existing, execution.deliveryEpoch);
    const botFriendCode =
      body.botUserFriendCode ?? existing.botUserFriendCode ?? null;
    if (!botFriendCode) {
      throw new ConflictException({
        code: 'invalid_route',
        message: 'v2 execution must identify its Bot',
      });
    }
    this.assertV2QueueRoute(existing, execution.queueName, botFriendCode);
    const generation = this.classifyExecutionGeneration(
      existing,
      execution,
      botFriendCode,
    );
    if (generation === 'new') {
      await this.assertV2AssignmentEligibility(
        existing,
        execution.workerId,
        botFriendCode,
      );
    }
    const reservesRelationship =
      generation === 'new' &&
      this.isRelationshipOwning(existing) &&
      !this.mayReuseCabinetPrerequisite(existing, botFriendCode);
    const mutate = () =>
      this.commitV2Patch(existing, body, botFriendCode, generation);
    if (reservesRelationship) {
      const result = await this.assignmentMutex.run(
        botFriendCode,
        async ({ assertActive }) => {
          assertActive();
          await this.assertEffectiveFriendCapacity(
            botFriendCode,
            existing.id,
            true,
          );
          assertActive();
          return mutate();
        },
      );
      if (!result.acquired) {
        throw new DxnetBotAssignmentBusyException();
      }
      return result.value;
    }
    return mutate();
  }

  private assertV2JobMayMutate(
    existing: JobEntity,
    deliveryEpoch: number,
  ): void {
    if (['completed', 'failed', 'canceled'].includes(existing.status)) {
      throw new GoneException({ code: 'job_terminal' });
    }
    if (existing.deadlineAt && existing.deadlineAt.getTime() <= Date.now()) {
      throw new GoneException({ code: 'job_terminal' });
    }
    if (
      existing.routing?.version !== 2 ||
      existing.routing.deliveryEpoch !== deliveryEpoch
    ) {
      throw new ConflictException({ code: 'stale_execution' });
    }
  }

  private async assertV2AssignmentEligibility(
    existing: JobEntity,
    workerId: string,
    botFriendCode: string,
  ): Promise<void> {
    const bot = await this.botStatus.getByFriendCode(botFriendCode);
    this.assertV2Heartbeat(bot, workerId);
    const control = await this.routingControl.get();
    if (!this.routingControl.isBotAllowed(control, botFriendCode)) {
      throw botIneligible('allowlist');
    }
    if (this.isRelationshipOwning(existing)) {
      this.assertV2RelationshipEligibility(existing, bot);
    }
  }

  private assertV2QueueRoute(
    existing: JobEntity,
    queueName: string,
    botFriendCode: string,
  ): void {
    const routing = existing.routing;
    if (!routing) {
      throw new ConflictException({ code: 'invalid_route' });
    }
    let expectedQueue: string;
    if (routing.deliveryMode === 'shared') {
      expectedQueue = getDxnetSharedQueueName(routing.lane);
    } else {
      if (
        !existing.botUserFriendCode ||
        existing.botUserFriendCode !== botFriendCode
      ) {
        throw new ConflictException({ code: 'invalid_route' });
      }
      expectedQueue = getDxnetPinnedQueueName(
        existing.botUserFriendCode,
        routing.lane,
      );
    }
    if (queueName !== expectedQueue) {
      throw new ConflictException({
        code: 'invalid_route',
        message: `expected queue ${expectedQueue}`,
      });
    }
  }

  private assertV2Heartbeat(
    bot: BotStatus | null,
    workerId: string,
  ): asserts bot is BotStatus {
    if (
      !bot ||
      !bot.available ||
      !bot.workerId ||
      !this.botStatus.hasExpectedConsumers(bot) ||
      bot.workerId !== workerId ||
      Date.now() - new Date(bot.lastReportedAt).getTime() > 90_000
    ) {
      throw botIneligible('heartbeat');
    }
  }

  private assertV2RelationshipEligibility(
    existing: JobEntity,
    bot: BotStatus,
  ): void {
    if (this.mayReuseCabinetPrerequisite(existing, bot.friendCode)) {
      return;
    }
    if (
      existing.cabinetFriendship?.status !== 'not_required' &&
      bot.cabinetUserId === null
    ) {
      throw botIneligible('cabinet_binding');
    }
    if (
      !bot.friendsUpdatedAt ||
      Date.now() - new Date(bot.friendsUpdatedAt).getTime() > 5 * 60_000
    ) {
      throw botIneligible('snapshot_stale');
    }
    if (bot.friendCount === null || bot.friendCount >= 50) {
      throw botIneligible('capacity');
    }
  }

  private classifyExecutionGeneration(
    existing: JobEntity,
    incoming: NonNullable<JobPatchBody['execution']>,
    botFriendCode: string,
  ): 'new' | 'same' {
    const current = existing.execution;
    if (!current) {
      return 'new';
    }
    if (
      current.deliveryEpoch === incoming.deliveryEpoch &&
      current.attemptsStarted === incoming.attemptsStarted &&
      current.workerId === incoming.workerId &&
      existing.botUserFriendCode === botFriendCode
    ) {
      return 'same';
    }
    if (
      current.deliveryEpoch === incoming.deliveryEpoch &&
      incoming.attemptsStarted > current.attemptsStarted
    ) {
      return 'new';
    }
    throw new ConflictException({ code: 'stale_execution' });
  }

  private async commitV2Patch(
    existing: JobEntity,
    body: JobPatchBody,
    botFriendCode: string,
    generation: 'new' | 'same',
  ) {
    const execution = body.execution;
    const { updateOps, finalStatuses } = this.buildPatchOperations(
      existing,
      body,
    );
    const set = updateOps.$set as Record<string, unknown>;
    const stagedDataCompletion =
      body.status === 'completed' &&
      ['update_score', 'get_user_recent_event'].includes(existing.jobType);
    if (stagedDataCompletion) {
      set.status = 'processing';
      set.completionPending = true;
      set.deadlineAt = new Date(
        Math.max(
          existing.deadlineAt?.getTime() ?? 0,
          Date.now() + COMPLETION_GRACE_MS,
        ),
      );
    } else if (
      body.status &&
      ['completed', 'failed', 'canceled'].includes(body.status)
    ) {
      set.completionPending = false;
    }
    set.botUserFriendCode = botFriendCode;
    set.execution = {
      deliveryEpoch: execution.deliveryEpoch,
      attemptsStarted: execution.attemptsStarted,
      workerId: execution.workerId,
      startedAt:
        generation === 'same' && existing.execution?.startedAt
          ? existing.execution.startedAt
          : new Date(),
    };
    this.applyV2CabinetExecution(
      existing,
      set,
      generation,
      execution,
      botFriendCode,
    );
    this.applyV2Handoff(
      existing,
      set,
      body,
      execution.deliveryEpoch,
      generation,
    );

    const filter: Record<string, unknown> = {
      id: existing.id,
      status: { $nin: ['completed', 'failed', 'canceled'] },
      'routing.version': 2,
      'routing.deliveryEpoch': execution.deliveryEpoch,
    };
    if (generation === 'same') {
      filter['execution.deliveryEpoch'] = execution.deliveryEpoch;
      filter['execution.attemptsStarted'] = execution.attemptsStarted;
      filter['execution.workerId'] = execution.workerId;
    } else if (existing.execution) {
      filter['execution.deliveryEpoch'] = existing.execution.deliveryEpoch;
      filter['execution.attemptsStarted'] = existing.execution.attemptsStarted;
      filter['execution.workerId'] = existing.execution.workerId;
    } else {
      filter.execution = null;
    }
    const updated = await this.jobModel.findOneAndUpdate(filter, updateOps, {
      new: true,
    });
    if (!updated) {
      throw new ConflictException({ code: 'stale_execution' });
    }
    let entity = updated.toObject() as JobEntity;
    if (stagedDataCompletion) {
      entity = await this.finalizeStagedCompletion(
        entity,
        existing.id,
        execution,
      );
    }
    this.cleanupFinalJobCache(existing.id, entity.status, finalStatuses);
    if (!stagedDataCompletion) {
      await this.handleCompletedUpdateScore(entity, existing.id);
      await this.handleCompletedRecentEvent(entity, existing.id);
    }
    this.recordPatchTimeline(existing, entity, body);
    if (body.handoff) {
      await this.jobQueue.enqueueWorkerJob(entity);
    }
    return toWorkerJobResponse(entity);
  }

  private async finalizeStagedCompletion(
    entity: JobEntity,
    jobId: string,
    execution: NonNullable<JobPatchBody['execution']>,
  ): Promise<JobEntity> {
    const completionCandidate = {
      ...entity,
      status: 'completed' as const,
      runAt: null,
    };
    await this.handleCompletedUpdateScore(completionCandidate, jobId);
    await this.handleCompletedRecentEvent(completionCandidate, jobId);
    const finalized = await this.jobModel.findOneAndUpdate(
      {
        id: jobId,
        status: 'processing',
        completionPending: true,
        'routing.deliveryEpoch': execution.deliveryEpoch,
        'execution.deliveryEpoch': execution.deliveryEpoch,
        'execution.attemptsStarted': execution.attemptsStarted,
        'execution.workerId': execution.workerId,
      },
      {
        $set: {
          status: 'completed',
          completionPending: false,
          runAt: null,
          updatedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!finalized) {
      throw new ConflictException({ code: 'stale_execution' });
    }
    return finalized.toObject() as JobEntity;
  }

  private applyV2CabinetExecution(
    existing: JobEntity,
    set: Record<string, unknown>,
    generation: 'new' | 'same',
    execution: NonNullable<JobPatchBody['execution']>,
    botFriendCode: string,
  ): void {
    if (!existing.cabinetFriendship) {
      return;
    }
    set['cabinetFriendship.botFriendCode'] = botFriendCode;
    if (generation !== 'new') {
      return;
    }
    set['cabinetFriendship.deliveryEpoch'] = execution.deliveryEpoch;
    set['cabinetFriendship.attemptsStarted'] = execution.attemptsStarted;
    if (!this.mayReuseCabinetPrerequisite(existing, botFriendCode)) {
      set['cabinetFriendship.status'] =
        existing.cabinetFriendship.status === 'not_required'
          ? 'not_required'
          : 'pending';
      set['cabinetFriendship.sdgbJobId'] = null;
      set['cabinetFriendship.lastError'] = null;
    }
  }

  private applyV2Handoff(
    existing: JobEntity,
    set: Record<string, unknown>,
    body: JobPatchBody,
    deliveryEpoch: number,
    generation: 'new' | 'same',
  ): void {
    if (!body.handoff) {
      return;
    }
    if (
      generation !== 'same' ||
      existing.jobType !== 'get_user_recent_event' ||
      existing.routing?.assignmentMode !== 'claim' ||
      existing.routing.deliveryMode !== 'shared' ||
      body.status !== 'queued' ||
      !['ready', 'uncertain'].includes(existing.cabinetFriendship?.status ?? '')
    ) {
      throw new ConflictException({ code: 'invalid_route' });
    }
    set['routing.deliveryMode'] = 'pinned';
    set['routing.deliveryEpoch'] = deliveryEpoch + 1;
    set.status = 'queued';
    set.runAt = this.parseIsoDate(body.handoff.runAt, 'handoff.runAt');
    set.execution = null;
  }

  private mayReuseCabinetPrerequisite(
    existing: JobEntity,
    botFriendCode: string,
  ): boolean {
    const friendship = existing.cabinetFriendship;
    return (
      existing.routing?.assignmentMode === 'claim' &&
      existing.botUserFriendCode === botFriendCode &&
      friendship?.botFriendCode === botFriendCode &&
      (friendship.status === 'ready' ||
        friendship.status === 'uncertain' ||
        (friendship.status === 'running' && !!friendship.sdgbJobId))
    );
  }

  private isRelationshipOwning(job: JobEntity): boolean {
    return (
      job.jobType === 'send_friend_request' ||
      job.jobType === 'accept_friend_request' ||
      (!!job.cabinetFriendship &&
        job.cabinetFriendship.status !== 'not_required')
    );
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
    if (body.errorCode !== undefined) {
      update.errorCode = body.errorCode;
    }
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
      !updated.friendCode ||
      !updated.result
    ) {
      return;
    }
    const sync = await this.syncService.createFromJob({
      id: updated.id,
      friendCode: updated.friendCode,
      jobType: updated.jobType,
      result: updated.result as unknown,
    });
    if (!sync?.id) {
      return;
    }
    if (sync.changedChartCount <= 0) {
      return;
    }
    this.proberExports
      .ensureAutoExportWake(updated.friendCode)
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
      !updated.friendCode ||
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
    this.enqueueFcfsAutoExport(updated, mergeResult);
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
    mergeResult: {
      updatedCount: number;
      syncId: string | null;
    },
  ): void {
    if (
      updated.context?.autoUpdateFcfs !== true ||
      !updated.friendCode ||
      mergeResult.updatedCount <= 0 ||
      !mergeResult.syncId
    ) {
      return;
    }
    this.proberExports
      .ensureAutoExportWake(updated.friendCode)
      .catch((err: Error) => {
        this.logger.warn(
          `failed to enqueue fcfs auto-export job=${updated.id}: ${err?.message}`,
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

    return jobs
      .map((job) => job.friendCode)
      .filter((friendCode): friendCode is string => !!friendCode);
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

  async countActiveUpdateScoreBySource(source: string): Promise<number> {
    return this.jobModel.countDocuments({
      jobType: 'update_score',
      status: { $in: ['queued', 'processing'] },
      'context.source': source,
    });
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
    const terminalCount = completedCount + failedCount;

    return {
      totalCount,
      completedCount,
      failedCount,
      successRate:
        terminalCount > 0
          ? Math.round((completedCount / terminalCount) * 10000) / 100
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

function byFriendCount(
  left: { friendCount: number | null },
  right: { friendCount: number | null },
): number {
  return (
    (left.friendCount ?? Number.MAX_SAFE_INTEGER) -
    (right.friendCount ?? Number.MAX_SAFE_INTEGER)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function botIneligible(
  reason:
    | 'heartbeat'
    | 'allowlist'
    | 'cabinet_binding'
    | 'snapshot_stale'
    | 'capacity',
): ConflictException {
  return new ConflictException({ code: 'bot_ineligible', reason });
}
