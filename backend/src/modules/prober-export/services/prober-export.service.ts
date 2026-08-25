/* eslint-disable max-lines */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { Queue, QueueEvents } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Types, type Model } from 'mongoose';

import {
  DEFAULT_WORKER_JOB_OPTIONS,
  PROBER_EXPORT_QUEUE_NAME,
  type ProberExportJobData,
  createBullmqQueueOptions,
} from '../../../common/bullmq/bullmq.config';
import { runMaintenanceWithLease } from '../../../common/redis/redis-lease.defaults';
import {
  RedisLeaseService,
  type RedisLeaseContext,
} from '../../../common/redis/redis-lease.service';
import {
  type CurrentExportSnapshot,
  SyncService,
} from '../../sync/services/sync.service';
import { ObservabilityIngestService } from '../../observability/services/observability-ingest.service';
import { UsersService } from '../../users/services/users.service';
import {
  ProberExportJobEntity,
  type ProberExportJobDocument,
  type ProberExportProvider,
  type ProberExportProviderResult,
  type ProberExportResult,
  type ProberExportStatus,
  type ProberExportTrigger,
} from '../schemas/prober-export-job.schema';
import {
  ProberExportStateEntity,
  type ProberExportStateDocument,
  type ProviderExportState,
  providerDefault,
} from '../schemas/prober-export-state.schema';

type UserWithTokens = {
  _id?: unknown;
  divingFishImportToken?: string | null;
  lxnsImportToken?: string | null;
};

type SyncExportResponse = {
  status: number | string;
  reason?: string;
  scores?: number;
  exported?: number;
  skipped?: number;
  response?: unknown;
};

type ProviderExecution = {
  result: ProberExportProviderResult;
  invalidToken: boolean;
};
type CurrentProberExportDelivery =
  | { kind: 'auto'; friendCode: string }
  | { kind: 'manual'; jobId: string; friendCode: string };

export type ProberExportProcessOutcome =
  | { kind: 'done' }
  | { kind: 'not_found' }
  | { kind: 'lease_busy'; delayMs: number };

export type ProberExportJobView = {
  id: string;
  kind: 'auto' | 'manual';
  trigger: ProberExportTrigger;
  friendCode: string;
  syncId: string;
  requestedScoreVersion: number | null;
  exportedScoreVersion: number | null;
  sourceJobId: string | null;
  sourceTaskId: string | null;
  targets: ProberExportProvider[];
  status: ProberExportStatus;
  attempts: number;
  result: ProberExportResult | null;
  error: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProberExportStateView = {
  providers: Record<
    ProberExportProvider,
    {
      enabled: boolean;
      lastSuccessVersion: number | null;
      status: 'idle' | 'processing' | 'failed';
      error: string | null;
      updatedAt: string | null;
    }
  >;
};

const RECONCILE_INTERVAL_MS = Number(
  process.env.PROBER_EXPORT_RECONCILE_INTERVAL_MS ?? 30_000,
);
const CLAIM_TTL_MS = Number(process.env.PROBER_EXPORT_CLAIM_TTL_MS ?? 90_000);
const CLAIM_HEARTBEAT_MS = Number(
  process.env.PROBER_EXPORT_CLAIM_HEARTBEAT_MS ?? 30_000,
);
const HARD_TIMEOUT_MS = Number(
  process.env.PROBER_EXPORT_HARD_TIMEOUT_MS ?? 25 * 60_000,
);
const ORPHAN_PROCESSING_MS = Number(
  process.env.PROBER_EXPORT_ORPHAN_PROCESSING_MS ?? 30 * 60_000,
);
const TERMINAL_STATUSES: ProberExportStatus[] = [
  'completed',
  'partial_failed',
  'failed',
  'skipped',
];

function toView(doc: ProberExportJobEntity): ProberExportJobView {
  return {
    id: doc.id,
    kind: doc.kind ?? (doc.trigger === 'manual' ? 'manual' : 'auto'),
    trigger: doc.trigger,
    friendCode: doc.friendCode,
    syncId: doc.syncId,
    requestedScoreVersion: doc.requestedScoreVersion ?? null,
    exportedScoreVersion: doc.exportedScoreVersion ?? null,
    sourceJobId: doc.sourceJobId ?? null,
    sourceTaskId: doc.sourceTaskId ?? null,
    targets: doc.targets ?? [],
    status: doc.status,
    attempts: doc.attempts ?? 0,
    result: doc.result ?? null,
    error: doc.error ?? null,
    claimedAt: doc.claimedAt?.toISOString() ?? null,
    completedAt: doc.completedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInvalidTokenError(
  target: ProberExportProvider,
  message: string,
): boolean {
  if (target === 'divingFish') {
    return /Diving-fish responded 400/i.test(message) && /token/i.test(message);
  }
  return /LXNS responded 401/i.test(message);
}

@Injectable()
export class ProberExportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProberExportService.name);
  private readonly queue: Queue<ProberExportJobData>;
  private readonly queueEvents: QueueEvents;
  private readonly instanceId = `${hostname()}:${process.pid}`;
  private readonly autoExportEnabled: boolean;
  private bootstrapAfterId: Types.ObjectId | null = null;
  private bootstrapComplete = false;

  constructor(
    @InjectModel(ProberExportJobEntity.name)
    private readonly model: Model<ProberExportJobDocument>,
    @InjectModel(ProberExportStateEntity.name)
    private readonly stateModel: Model<ProberExportStateDocument>,
    private readonly users: UsersService,
    private readonly syncs: SyncService,
    private readonly leases: RedisLeaseService,
    private readonly observability: ObservabilityIngestService,
    config: ConfigService,
  ) {
    const queueOptions = createBullmqQueueOptions(config);
    this.queue = new Queue<ProberExportJobData>(PROBER_EXPORT_QUEUE_NAME, {
      ...queueOptions,
      defaultJobOptions: DEFAULT_WORKER_JOB_OPTIONS,
    });
    this.queueEvents = new QueueEvents(PROBER_EXPORT_QUEUE_NAME, queueOptions);
    this.autoExportEnabled =
      config.get<string>('PROBER_AUTO_EXPORT_ENABLED', 'true') === 'true';
  }

  onModuleInit(): void {
    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      if (!jobId) {
        return;
      }
      void this.markManualDeliveryFailed(jobId, failedReason).catch((error) =>
        this.logger.warn(
          `failed to mirror manual export delivery failure id=${jobId}: ${errorMessage(error)}`,
        ),
      );
    });
    this.queueEvents.on('error', (error) =>
      this.logger.warn(`prober export QueueEvents error: ${error.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.queueEvents.close();
  }

  /** Compatibility facade for existing score finalizers during rollout. */
  async enqueueAutoExportForSync(input: {
    trigger: Exclude<ProberExportTrigger, 'manual'>;
    friendCode: string;
    syncId: string;
    sourceJobId?: string | null;
    sourceTaskId?: string | null;
  }): Promise<null> {
    await this.ensureAutoExportWake(input.friendCode);
    return null;
  }

  async ensureAutoExportWake(friendCode: string): Promise<void> {
    if (!this.autoExportEnabled) {
      return;
    }
    const state = await this.ensureStateFromUser(friendCode);
    if (!state || !this.hasEnabledProvider(state)) {
      return;
    }
    await this.ensureQueueDelivery(
      this.autoWakeId(friendCode),
      { kind: 'auto', friendCode },
      10,
    );
  }

  async updateProviderConfiguration(input: {
    friendCode: string;
    ownerUserId?: string | null;
    resetProviders?: ProberExportProvider[];
  }): Promise<void> {
    const state = await this.ensureStateFromUser(
      input.friendCode,
      input.ownerUserId,
      input.resetProviders ?? [],
    );
    if (state && this.hasEnabledProvider(state)) {
      await this.ensureAutoExportWake(input.friendCode);
    }
  }

  async enqueueManualExport(input: {
    friendCode: string;
    syncId: string;
    target: ProberExportProvider;
  }): Promise<ProberExportJobView> {
    const user = await this.users.findByFriendCode(input.friendCode);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!this.tokenFor(user, input.target)) {
      throw new BadRequestException(
        input.target === 'divingFish'
          ? 'User missing divingFishImportToken'
          : 'User missing lxnsImportToken',
      );
    }
    await this.ensureStateFromUser(input.friendCode);
    const snapshot = await this.syncs.getCurrentExportSnapshot(
      input.friendCode,
    );
    const now = new Date();
    const id = randomUUID();
    const created = await this.model.create({
      id,
      kind: 'manual',
      trigger: 'manual',
      friendCode: input.friendCode,
      ownerUserId: this.objectIdOrNull(user._id),
      syncId: snapshot.syncId,
      requestedScoreVersion: snapshot.scoreVersion,
      exportedScoreVersion: null,
      sourceJobId: null,
      sourceTaskId: null,
      targets: [input.target],
      status: 'queued',
      attempts: 0,
      result: null,
      error: null,
      claimToken: null,
      claimedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.ensureQueueDelivery(
        id,
        { kind: 'manual', jobId: id, friendCode: input.friendCode },
        1,
      );
      this.recordTimeline(
        created.toObject() as ProberExportJobEntity,
        null,
        'queued',
        now,
      );
    } catch (error) {
      const failedAt = new Date();
      const failed = await this.model.findOneAndUpdate(
        { id, status: 'queued' },
        {
          $set: {
            status: 'failed',
            error: `failed to enqueue manual export: ${errorMessage(error)}`,
            completedAt: failedAt,
            updatedAt: failedAt,
          },
        },
        { new: true },
      );
      if (failed) {
        this.recordTimeline(
          failed.toObject() as ProberExportJobEntity,
          'queued',
          'failed',
          failedAt,
        );
      }
      throw error;
    }
    return toView(created.toObject() as ProberExportJobEntity);
  }

  async getForUser(
    exportJobId: string,
    friendCode: string,
  ): Promise<ProberExportJobView> {
    const doc = await this.model
      .findOne({ id: exportJobId, friendCode })
      .lean<ProberExportJobEntity | null>();
    if (!doc) {
      throw new NotFoundException('Prober export job not found');
    }
    return toView(doc);
  }

  async getRecentForUser(
    friendCode: string,
    limit: number,
  ): Promise<ProberExportJobView[]> {
    const docs = await this.model
      .find({ friendCode })
      .sort({ createdAt: -1 })
      .limit(Math.min(100, Math.max(1, limit)))
      .lean<ProberExportJobEntity[]>();
    return docs.map(toView);
  }

  async getStateForUser(
    friendCode: string,
  ): Promise<ProberExportStateView | null> {
    const state = await this.stateModel
      .findOne({ friendCode })
      .lean<ProberExportStateEntity | null>();
    if (!state) {
      return null;
    }
    return {
      providers: {
        divingFish: this.toProviderStateView(state.providers.divingFish),
        lxns: this.toProviderStateView(state.providers.lxns),
      },
    };
  }

  async processDelivery(
    data: ProberExportJobData,
  ): Promise<ProberExportProcessOutcome> {
    if (!('kind' in data)) {
      return this.processLegacyDelivery(data.jobId);
    }
    const currentData: CurrentProberExportDelivery = data;
    if (currentData.kind === 'manual') {
      const job = await this.model
        .findOne({ id: currentData.jobId })
        .select({ status: 1 })
        .lean<{ status: ProberExportStatus } | null>();
      if (!job || TERMINAL_STATUSES.includes(job.status)) {
        return { kind: 'not_found' };
      }
    }

    const state = await this.ensureStateFromUser(currentData.friendCode);
    if (!state) {
      return { kind: 'not_found' };
    }
    const lease = await this.leases.run(
      {
        name: `prober-export-user:${this.friendHash(currentData.friendCode)}`,
        ttlMs: CLAIM_TTL_MS,
        renewEveryMs: CLAIM_HEARTBEAT_MS,
        hardTimeoutMs: HARD_TIMEOUT_MS,
        abortGraceMs: 30_000,
      },
      (context) => this.processUnderLease(currentData, context),
    );
    if (!lease.acquired || lease.value === 'claim_busy') {
      return { kind: 'lease_busy', delayMs: this.leaseRetryDelay() };
    }
    return { kind: 'done' };
  }

  private async processLegacyDelivery(
    jobId: string,
  ): Promise<ProberExportProcessOutcome> {
    const legacy = await this.model
      .findOne({ id: jobId })
      .lean<ProberExportJobEntity | null>();
    if (!legacy) {
      return { kind: 'not_found' };
    }
    if (legacy.trigger === 'manual') {
      return this.processDelivery({
        kind: 'manual',
        jobId,
        friendCode: legacy.friendCode,
      });
    }
    const completedAt = new Date();
    const skipped = await this.model.findOneAndUpdate(
      { id: jobId, status: { $nin: TERMINAL_STATUSES } },
      {
        $set: {
          status: 'skipped',
          error: 'superseded by version reconciliation',
          completedAt,
          updatedAt: completedAt,
        },
      },
      { new: true },
    );
    if (skipped) {
      this.recordTimeline(
        skipped.toObject() as ProberExportJobEntity,
        legacy.status,
        'skipped',
        completedAt,
      );
    }
    await this.ensureAutoExportWake(legacy.friendCode);
    return { kind: 'done' };
  }

  @Interval(RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    await runMaintenanceWithLease(
      this.leases,
      'prober-export-reconcile',
      ({ signal }) => this.reconcileOnce(signal),
    );
  }

  private async reconcileOnce(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.autoExportEnabled) {
      await this.repairQueuedManualJobs(signal);
      await this.releaseOrphanAttempts(signal);
      return;
    }
    await this.bootstrapEnabledStates(signal);
    const now = new Date();
    const states = await this.stateModel
      .find({
        $and: [
          {
            $or: [
              { 'providers.divingFish.enabled': true },
              { 'providers.lxns.enabled': true },
            ],
          },
          {
            $or: [
              { nextReconcileAt: null },
              { nextReconcileAt: { $lte: now } },
            ],
          },
        ],
      })
      .sort({ nextReconcileAt: 1 })
      .limit(500)
      .lean<ProberExportStateEntity[]>();
    const versions = await this.syncs.getExportVersions(
      states.map((state) => state.friendCode),
    );
    const byFriendCode = new Map(
      versions.map((version) => [version.friendCode, version] as const),
    );

    for (const state of states) {
      signal.throwIfAborted();
      const version = byFriendCode.get(state.friendCode);
      if (version && this.stateNeedsExport(state, version.scoreVersion, now)) {
        await this.ensureQueueDelivery(
          this.autoWakeId(state.friendCode),
          { kind: 'auto', friendCode: state.friendCode },
          10,
        );
      }
      await this.stateModel.updateOne(
        { friendCode: state.friendCode },
        {
          $set: {
            nextReconcileAt: new Date(Date.now() + RECONCILE_INTERVAL_MS),
          },
        },
      );
    }

    await this.repairQueuedManualJobs(signal);
    await this.releaseOrphanAttempts(signal);
  }

  private async bootstrapEnabledStates(signal: AbortSignal): Promise<void> {
    if (this.bootstrapComplete) {
      return;
    }
    const users = await this.users.listUsersWithProberTokens({
      afterId: this.bootstrapAfterId,
      limit: 250,
    });
    for (const user of users) {
      signal.throwIfAborted();
      await this.ensureStateFromUser(user.friendCode, String(user._id));
    }
    if (users.length === 250) {
      this.bootstrapAfterId = users.at(-1)?._id ?? null;
    } else {
      this.bootstrapAfterId = null;
      this.bootstrapComplete = true;
    }
  }

  // The external side effect and both fencing layers are deliberately kept in
  // one control-flow scope so every exit releases the same claim.
  // eslint-disable-next-line max-lines-per-function
  private async processUnderLease(
    data: CurrentProberExportDelivery,
    lease: RedisLeaseContext,
  ): Promise<'done' | 'claim_busy'> {
    lease.assertActive();
    const claimToken = randomUUID();
    const now = new Date();
    const state = await this.stateModel
      .findOneAndUpdate(
        {
          friendCode: data.friendCode,
          $or: [{ claimUntil: null }, { claimUntil: { $lte: now } }],
        },
        {
          $set: {
            claimToken,
            claimedBy: this.instanceId,
            claimUntil: new Date(now.getTime() + CLAIM_TTL_MS),
            heartbeatAt: now,
          },
        },
        { new: true },
      )
      .lean<ProberExportStateEntity | null>();
    if (!state) {
      return 'claim_busy';
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(lease.signal.reason);
    lease.signal.addEventListener('abort', relayAbort, { once: true });
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || controller.signal.aborted) {
        return;
      }
      heartbeatRunning = true;
      void this.renewClaim(data.friendCode, claimToken)
        .then((renewed) => {
          if (!renewed) {
            controller.abort(new Error('export claim lost'));
          }
        })
        .catch((error) => controller.abort(error))
        .finally(() => {
          heartbeatRunning = false;
        });
    }, CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();

    let attemptId: string | null = null;
    try {
      const [user, snapshot] = await Promise.all([
        this.users.findByFriendCode(data.friendCode),
        this.syncs.getCurrentExportSnapshot(data.friendCode),
      ]);
      if (!user) {
        throw new Error('User not found');
      }

      const targets =
        data.kind === 'manual'
          ? await this.claimManualJob(data.jobId, claimToken, snapshot)
          : this.resolveDueTargets(state, snapshot.scoreVersion, user);
      if (!targets?.length) {
        return 'done';
      }

      if (data.kind === 'manual') {
        attemptId = data.jobId;
      } else {
        attemptId = await this.createAutoAttempt(
          data.friendCode,
          user,
          snapshot,
          targets,
          claimToken,
        );
      }
      if (!attemptId) {
        throw new Error('export attempt was not created');
      }

      await this.markProvidersProcessing(
        data.friendCode,
        claimToken,
        targets,
        snapshot.scoreVersion,
      );
      const executions = new Map<ProberExportProvider, ProviderExecution>();
      for (const target of targets) {
        lease.assertActive();
        controller.signal.throwIfAborted();
        executions.set(
          target,
          await this.exportTarget(snapshot, target, user, controller.signal),
        );
      }
      lease.assertActive();
      controller.signal.throwIfAborted();

      const result = Object.fromEntries(
        [...executions].map(([target, execution]) => [
          target,
          execution.result,
        ]),
      ) as ProberExportResult;
      const status = this.aggregateStatus(targets, result);
      await this.publishStateResult({
        friendCode: data.friendCode,
        claimToken,
        scoreVersion: snapshot.scoreVersion,
        executions,
        providersBefore: state.providers,
      });
      await this.completeAttempt(
        attemptId,
        claimToken,
        snapshot.scoreVersion,
        status,
        result,
        null,
      );
      return 'done';
    } catch (error) {
      if (attemptId) {
        await this.completeAttempt(
          attemptId,
          claimToken,
          null,
          'failed',
          {},
          errorMessage(error),
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      lease.signal.removeEventListener('abort', relayAbort);
      await this.releaseClaim(data.friendCode, claimToken).catch(
        () => undefined,
      );
    }
  }

  private async claimManualJob(
    jobId: string,
    claimToken: string,
    snapshot: CurrentExportSnapshot,
  ): Promise<ProberExportProvider[] | null> {
    const now = new Date();
    const job = await this.model
      .findOneAndUpdate(
        { id: jobId, status: 'queued' },
        {
          $set: {
            status: 'processing',
            claimToken,
            claimedAt: now,
            exportedScoreVersion: snapshot.scoreVersion,
            error: null,
            updatedAt: now,
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .lean<ProberExportJobEntity | null>();
    if (job) {
      this.recordTimeline(job, 'queued', 'processing', now);
    }
    return job?.targets ?? null;
  }

  private async createAutoAttempt(
    friendCode: string,
    user: UserWithTokens,
    snapshot: CurrentExportSnapshot,
    targets: ProberExportProvider[],
    claimToken: string,
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    const created = await this.model.create({
      id,
      kind: 'auto',
      trigger: 'auto_latest',
      friendCode,
      ownerUserId: this.objectIdOrNull(user._id),
      syncId: snapshot.syncId,
      requestedScoreVersion: snapshot.scoreVersion,
      exportedScoreVersion: snapshot.scoreVersion,
      sourceJobId: null,
      sourceTaskId: null,
      targets,
      status: 'processing',
      attempts: 1,
      result: null,
      error: null,
      claimToken,
      claimedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.recordTimeline(
      created.toObject() as ProberExportJobEntity,
      null,
      'processing',
      now,
    );
    return id;
  }

  private async publishStateResult(input: {
    friendCode: string;
    claimToken: string;
    scoreVersion: number;
    executions: Map<ProberExportProvider, ProviderExecution>;
    providersBefore: ProberExportStateEntity['providers'];
  }): Promise<void> {
    const now = new Date();
    const set: Record<string, unknown> = {
      claimToken: null,
      claimedBy: null,
      claimUntil: null,
      heartbeatAt: null,
      nextReconcileAt: new Date(now.getTime() + RECONCILE_INTERVAL_MS),
    };
    const max: Record<string, number> = {};

    for (const [target, execution] of input.executions) {
      const prefix = `providers.${target}`;
      const succeeded =
        execution.result.status === 'success' ||
        execution.result.status === 'skipped';
      set[`${prefix}.lastAttemptVersion`] = input.scoreVersion;
      set[`${prefix}.status`] = succeeded ? 'idle' : 'failed';
      const failureCount = succeeded
        ? 0
        : (input.providersBefore[target].failureCount ?? 0) + 1;
      set[`${prefix}.failureCount`] = failureCount;
      set[`${prefix}.error`] = succeeded
        ? null
        : (execution.result.message ?? 'export failed');
      set[`${prefix}.result`] = execution.result;
      set[`${prefix}.updatedAt`] = now;
      set[`${prefix}.nextAttemptAt`] = succeeded
        ? null
        : this.nextRetryAt(now, failureCount);
      if (execution.invalidToken) {
        set[`${prefix}.enabled`] = false;
      }
      if (succeeded) {
        max[`${prefix}.lastSuccessVersion`] = input.scoreVersion;
      }
    }

    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(max).length) {
      update.$max = max;
    }
    const result = await this.stateModel.updateOne(
      { friendCode: input.friendCode, claimToken: input.claimToken },
      update,
    );
    if (result.modifiedCount !== 1) {
      throw new Error('export claim lost');
    }
  }

  private async completeAttempt(
    attemptId: string,
    claimToken: string,
    exportedScoreVersion: number | null,
    status: ProberExportStatus,
    result: ProberExportResult,
    error: string | null,
  ): Promise<void> {
    const completedAt = new Date();
    const completed = await this.model.findOneAndUpdate(
      { id: attemptId, claimToken },
      {
        $set: {
          status,
          result,
          error,
          exportedScoreVersion,
          claimToken: null,
          completedAt,
          updatedAt: completedAt,
        },
      },
      { new: true },
    );
    if (completed) {
      this.recordTimeline(
        completed.toObject() as ProberExportJobEntity,
        'processing',
        status,
        completedAt,
      );
    }
  }

  private recordTimeline(
    job: ProberExportJobEntity,
    fromStatus: ProberExportStatus | null,
    toStatus: ProberExportStatus,
    ts: Date,
  ): void {
    const terminal = TERMINAL_STATUSES.includes(toStatus);
    this.observability.recordJobTimelineEvent({
      ts,
      jobId: job.id,
      jobKind: 'prober_export',
      jobType: job.trigger,
      eventName: toStatus === 'processing' ? 'picked' : toStatus,
      fromStatus,
      toStatus,
      workerId: toStatus === 'queued' ? null : this.instanceId,
      durationMs: terminal ? ts.getTime() - job.createdAt.getTime() : null,
      errorClass:
        toStatus === 'failed' || toStatus === 'partial_failed'
          ? 'prober_export_failed'
          : null,
      message: job.error,
      attrs: {
        kind: job.kind,
        targets: job.targets.join(','),
      },
    });
  }

  private async exportTarget(
    snapshot: CurrentExportSnapshot,
    target: ProberExportProvider,
    user: UserWithTokens,
    signal: AbortSignal,
  ): Promise<ProviderExecution> {
    const token = this.tokenFor(user, target);
    if (!token) {
      return {
        invalidToken: true,
        result: {
          status: 'failed',
          message:
            target === 'divingFish'
              ? 'User missing divingFishImportToken'
              : 'User missing lxnsImportToken',
        },
      };
    }
    try {
      const response =
        target === 'divingFish'
          ? await this.syncs.exportSnapshotToDivingFish(snapshot, token, signal)
          : await this.syncs.exportSnapshotToLxns(snapshot, token, signal);
      return { invalidToken: false, result: this.toProviderResult(response) };
    } catch (error) {
      const message = errorMessage(error);
      const invalidToken = isInvalidTokenError(target, message);
      if (invalidToken) {
        await this.users.clearProberImportToken(snapshot.friendCode, target);
      }
      return {
        invalidToken,
        result: { status: 'failed', message },
      };
    }
  }

  private async ensureStateFromUser(
    friendCode: string,
    ownerUserId?: string | null,
    resetProviders: ProberExportProvider[] = [],
  ): Promise<ProberExportStateEntity | null> {
    const user = await this.users.findByFriendCode(friendCode);
    if (!user) {
      return null;
    }
    if (
      !user.divingFishImportToken &&
      !user.lxnsImportToken &&
      resetProviders.length === 0
    ) {
      const existing = await this.stateModel
        .findOne({ friendCode })
        .lean<ProberExportStateEntity | null>();
      if (!existing) {
        return null;
      }
    }
    const owner = this.objectIdOrNull(ownerUserId ?? user._id);
    const initialProviders = {
      divingFish: providerDefault(),
      lxns: providerDefault(),
    };
    await this.stateModel.updateOne(
      { friendCode },
      {
        $setOnInsert: {
          friendCode,
          ownerUserId: owner,
          providers: initialProviders,
          claimToken: null,
          claimUntil: null,
          claimedBy: null,
          heartbeatAt: null,
          nextReconcileAt: new Date(),
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    const set: Record<string, unknown> = {
      ownerUserId: owner,
      'providers.divingFish.enabled': !!user.divingFishImportToken,
      'providers.lxns.enabled': !!user.lxnsImportToken,
      nextReconcileAt: new Date(),
    };
    for (const target of resetProviders) {
      set[`providers.${target}.lastSuccessVersion`] = null;
      set[`providers.${target}.lastAttemptVersion`] = null;
      set[`providers.${target}.status`] = 'idle';
      set[`providers.${target}.failureCount`] = 0;
      set[`providers.${target}.error`] = null;
      set[`providers.${target}.result`] = null;
      set[`providers.${target}.nextAttemptAt`] = null;
    }
    return this.stateModel
      .findOneAndUpdate({ friendCode }, { $set: set }, { new: true })
      .lean<ProberExportStateEntity | null>();
  }

  private resolveDueTargets(
    state: ProberExportStateEntity,
    scoreVersion: number,
    user: UserWithTokens,
  ): ProberExportProvider[] {
    const now = Date.now();
    return (['divingFish', 'lxns'] as const).filter((target) => {
      const provider = state.providers[target];
      const due =
        provider.enabled &&
        (provider.lastSuccessVersion === null ||
          provider.lastSuccessVersion < scoreVersion) &&
        (!provider.nextAttemptAt || provider.nextAttemptAt.getTime() <= now);
      return due && !!this.tokenFor(user, target);
    });
  }

  private stateNeedsExport(
    state: ProberExportStateEntity,
    scoreVersion: number,
    now: Date,
  ): boolean {
    return (['divingFish', 'lxns'] as const).some((target) => {
      const provider = state.providers[target];
      return (
        provider.enabled &&
        (provider.lastSuccessVersion === null ||
          provider.lastSuccessVersion < scoreVersion) &&
        (!provider.nextAttemptAt || provider.nextAttemptAt <= now)
      );
    });
  }

  private async markProvidersProcessing(
    friendCode: string,
    claimToken: string,
    targets: ProberExportProvider[],
    scoreVersion: number,
  ): Promise<void> {
    const now = new Date();
    const set: Record<string, unknown> = {};
    for (const target of targets) {
      set[`providers.${target}.status`] = 'processing';
      set[`providers.${target}.lastAttemptVersion`] = scoreVersion;
      set[`providers.${target}.updatedAt`] = now;
    }
    const result = await this.stateModel.updateOne(
      { friendCode, claimToken },
      { $set: set },
    );
    if (result.modifiedCount !== 1) {
      throw new Error('export claim lost');
    }
  }

  private async renewClaim(
    friendCode: string,
    claimToken: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.stateModel.updateOne(
      { friendCode, claimToken },
      {
        $set: {
          heartbeatAt: now,
          claimUntil: new Date(now.getTime() + CLAIM_TTL_MS),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  private async releaseClaim(
    friendCode: string,
    claimToken: string,
  ): Promise<void> {
    await this.stateModel.updateOne(
      { friendCode, claimToken },
      {
        $set: {
          claimToken: null,
          claimUntil: null,
          claimedBy: null,
          heartbeatAt: null,
        },
      },
    );
  }

  private async repairQueuedManualJobs(signal: AbortSignal): Promise<void> {
    const queued = await this.model
      .find({
        status: 'queued',
        $or: [
          { kind: 'manual' },
          { kind: { $exists: false }, trigger: 'manual' },
        ],
      })
      .sort({ createdAt: 1 })
      .limit(200)
      .select({ id: 1, friendCode: 1 })
      .lean<Array<{ id: string; friendCode: string }>>();
    for (const job of queued) {
      signal.throwIfAborted();
      await this.ensureQueueDelivery(
        job.id,
        { kind: 'manual', jobId: job.id, friendCode: job.friendCode },
        1,
      );
    }
  }

  private async releaseOrphanAttempts(signal: AbortSignal): Promise<void> {
    const before = new Date(Date.now() - ORPHAN_PROCESSING_MS);
    const jobs = await this.model
      .find({ status: 'processing', claimedAt: { $lte: before } })
      .limit(200)
      .select({ id: 1, kind: 1, friendCode: 1, claimToken: 1 })
      .lean<
        Array<{
          id: string;
          kind: 'auto' | 'manual';
          friendCode: string;
          claimToken: string | null;
        }>
      >();
    for (const job of jobs) {
      signal.throwIfAborted();
      const activeState = job.claimToken
        ? await this.stateModel.exists({
            friendCode: job.friendCode,
            claimToken: job.claimToken,
            claimUntil: { $gt: new Date() },
          })
        : null;
      if (activeState) {
        continue;
      }
      if (job.kind === 'manual') {
        const requeuedAt = new Date();
        const requeued = await this.model.findOneAndUpdate(
          { id: job.id, status: 'processing', claimToken: job.claimToken },
          {
            $set: {
              status: 'queued',
              claimToken: null,
              claimedAt: null,
              error: 'orphan manual export claim released',
              updatedAt: requeuedAt,
            },
          },
          { new: true },
        );
        if (requeued) {
          this.recordTimeline(
            requeued.toObject() as ProberExportJobEntity,
            'processing',
            'queued',
            requeuedAt,
          );
        }
      } else {
        const failedAt = new Date();
        const failed = await this.model.findOneAndUpdate(
          { id: job.id, status: 'processing', claimToken: job.claimToken },
          {
            $set: {
              status: 'failed',
              claimToken: null,
              error: 'orphan automatic export claim released',
              completedAt: failedAt,
              updatedAt: failedAt,
            },
          },
          { new: true },
        );
        if (failed) {
          this.recordTimeline(
            failed.toObject() as ProberExportJobEntity,
            'processing',
            'failed',
            failedAt,
          );
        }
      }
    }
  }

  private async ensureQueueDelivery(
    jobId: string,
    data: ProberExportJobData,
    priority: number,
  ): Promise<void> {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (!['failed', 'completed'].includes(state)) {
        return;
      }
      await existing.remove();
    }
    await this.queue.add(
      'kind' in data && data.kind === 'auto' ? 'auto-export' : 'manual-export',
      data,
      {
        jobId,
        priority,
      },
    );
  }

  private async markManualDeliveryFailed(
    jobId: string,
    failedReason?: string,
  ): Promise<void> {
    const failedAt = new Date();
    const failed = await this.model.findOneAndUpdate(
      {
        id: jobId,
        status: { $nin: TERMINAL_STATUSES },
        $or: [
          { kind: 'manual' },
          { kind: { $exists: false }, trigger: 'manual' },
        ],
      },
      {
        $set: {
          status: 'failed',
          error: failedReason || 'BullMQ delivery failed',
          completedAt: failedAt,
          updatedAt: failedAt,
        },
      },
      { new: true },
    );
    if (failed) {
      this.recordTimeline(
        failed.toObject() as ProberExportJobEntity,
        null,
        'failed',
        failedAt,
      );
    }
  }

  private aggregateStatus(
    targets: ProberExportProvider[],
    result: ProberExportResult,
  ): ProberExportStatus {
    const entries = targets
      .map((target) => result[target])
      .filter((entry): entry is ProberExportProviderResult => !!entry);
    if (
      !entries.length ||
      entries.every((entry) => entry.status === 'skipped')
    ) {
      return 'skipped';
    }
    if (entries.every((entry) => entry.status === 'failed')) {
      return 'failed';
    }
    if (entries.some((entry) => entry.status === 'failed')) {
      return 'partial_failed';
    }
    return 'completed';
  }

  private toProviderResult(
    response: SyncExportResponse,
  ): ProberExportProviderResult {
    if (response.status === 'skipped') {
      return {
        status: 'skipped',
        message: response.reason ?? 'skipped',
        scores: response.scores,
        exported: response.exported,
        skipped: response.skipped,
        response: response.response,
      };
    }
    return {
      status: 'success',
      message: `导出 ${response.exported ?? 0} 条成绩`,
      scores: response.scores,
      exported: response.exported,
      skipped: response.skipped,
      response: response.response,
    };
  }

  private tokenFor(
    user: UserWithTokens,
    target: ProberExportProvider,
  ): string | null {
    return target === 'divingFish'
      ? (user.divingFishImportToken ?? null)
      : (user.lxnsImportToken ?? null);
  }

  private hasEnabledProvider(state: ProberExportStateEntity): boolean {
    return state.providers.divingFish.enabled || state.providers.lxns.enabled;
  }

  private toProviderStateView(provider: ProviderExportState) {
    return {
      enabled: provider.enabled,
      lastSuccessVersion: provider.lastSuccessVersion,
      status: provider.status,
      error: provider.error,
      updatedAt: provider.updatedAt?.toISOString() ?? null,
    };
  }

  private autoWakeId(friendCode: string): string {
    return `auto-export-${this.friendHash(friendCode)}`;
  }

  private friendHash(friendCode: string): string {
    return createHash('sha256').update(friendCode).digest('hex').slice(0, 24);
  }

  private leaseRetryDelay(): number {
    return 2_000 + Math.floor(Math.random() * 3_001);
  }

  private nextRetryAt(now: Date, failureCount: number): Date {
    const base = Math.min(
      6 * 60 * 60_000,
      60_000 * 2 ** Math.min(8, Math.max(0, failureCount - 1)),
    );
    const jitter = Math.floor(Math.random() * Math.min(30_000, base / 4));
    return new Date(now.getTime() + base + jitter);
  }

  private objectIdOrNull(value: unknown): Types.ObjectId | null {
    if (value instanceof Types.ObjectId) {
      return value;
    }
    const raw = typeof value === 'string' ? value : '';
    return raw && this.isObjectId(raw) ? new Types.ObjectId(raw) : null;
  }

  private isObjectId(value: string): boolean {
    return /^[a-f\d]{24}$/i.test(value);
  }
}
