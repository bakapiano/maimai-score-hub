import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import { UsersService } from '../../users/services/users.service';
import {
  QrLoginAttemptEntity,
  type QrLoginAttemptDocument,
  type QrLoginStatus,
} from '../schemas/qr-login-attempt.schema';
import {
  CabinetIdentityMatcherService,
  type PreparedCabinetIdentity,
} from './cabinet-identity-matcher.service';
import { AuthService } from './auth.service';
import { JobService } from '../../job/services/job.service';
import { RedisLeaseService } from '../../../common/redis/redis-lease.service';

const ACTIVE_ATTEMPT_STATUSES: QrLoginStatus[] = [
  'pending',
  'adding_rival',
  'waiting_snapshot',
];
const ATTEMPT_RECONCILE_INTERVAL_MS = 2_000;
const ATTEMPT_RECONCILE_BATCH_SIZE = 50;
type WorkerJobView = Awaited<ReturnType<JobService['getWorker']>>;

export interface QrLoginFastResult {
  kind: 'fast';
  token: string;
  user: { id: string; friendCode: string; [key: string]: unknown };
}

export interface QrLoginAsyncResult {
  kind: 'async';
  attemptId: string;
}

export type QrLoginInitResult = QrLoginFastResult | QrLoginAsyncResult;

export interface QrLoginPollResult {
  attemptId: string;
  status: QrLoginStatus;
  token?: string | null;
  user?: { id: string; friendCode: string; [key: string]: unknown } | null;
  error?: string | null;
}

/**
 * Thrown when the cabinet rejects the QR string as expired (errorID!=0,
 * userID=-1). Caller maps to a specific 400 response.
 */
export class QrExpiredError extends Error {
  constructor() {
    super('二维码已过期，请刷新机台二维码后再试');
    this.name = 'QrExpiredError';
  }
}

/**
 * QR-code login.
 *
 * Two paths:
 *  - FAST (sync): cabinetUserId already bound → look user up, sign a
 *    token, return { kind:'fast', token, user } from the original POST.
 *  - SLOW (async): brand-new user. The POST returns { kind:'async',
 *    attemptId } immediately; the FE polls /auth/qr-login/:id every
 *    second or two until status='matched' (token attached) or 'failed'
 *    (error attached). The actual work runs in the background:
 *      1. pick a bot
 *      2. addRival                    ← sdgb job
 *      3. dispatch high-priority full friend-list refresh job
 *      4. unique (name,rating) match in the snapshot → done
 */
@Injectable()
export class QrLoginService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QrLoginService.name);
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcileRunning = false;

  constructor(
    private readonly sdgb: SdgbJobDispatcher,
    private readonly users: UsersService,
    private readonly identityMatcher: CabinetIdentityMatcherService,
    private readonly auth: AuthService,
    @InjectModel(QrLoginAttemptEntity.name)
    private readonly attemptModel: Model<QrLoginAttemptDocument>,
    private readonly jobs: JobService,
    private readonly leases: RedisLeaseService,
  ) {}

  onModuleInit(): void {
    void this.runClaimAttemptReconcile();
    this.reconcileTimer = setInterval(
      () => void this.runClaimAttemptReconcile(),
      ATTEMPT_RECONCILE_INTERVAL_MS,
    );
    this.reconcileTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /**
   * Sync entry. Either signs a token immediately (fast path) or returns
   * an attemptId that the FE polls.
   */
  async loginByQr(qrCode: string): Promise<QrLoginInitResult> {
    if (!qrCode || !qrCode.trim()) {
      throw new Error('qrCode required');
    }

    let scan: Awaited<ReturnType<SdgbJobDispatcher['scanQr']>>;
    try {
      scan = await this.sdgb.scanQr(
        { qrCode: qrCode.trim() },
        { tag: `qr-login`, timeoutMs: 120_000 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('QR_EXPIRED')) {
        throw new QrExpiredError();
      }
      throw err;
    }

    // Fast path.
    const existing = await this.users.findByCabinetUserId(scan.cabinetUserId);
    if (existing) {
      this.logger.log(
        `QR-login fast path: cabinetUid=${scan.cabinetUserId} → friendCode=${existing.friendCode}`,
      );
      return {
        kind: 'fast',
        ...(await this.auth.issueTokenForUser(existing as never)),
      };
    }

    if (await this.identityMatcher.isClaimIdentityEnabled()) {
      const started = await this.identityMatcher.startClaimResolution(scan, {
        purpose: 'login',
      });
      this.logger.log(
        `QR-login claim path enqueued attemptId=${started.attemptId} cabinetUid=${started.identity.cabinetUserId}`,
      );
      return { kind: 'async', attemptId: started.attemptId };
    }

    const identity = await this.identityMatcher.prepare(scan);

    const attemptId = randomUUID();
    await this.attemptModel.create({
      id: attemptId,
      status: 'pending' as QrLoginStatus,
      purpose: 'login',
      ownerUserId: null,
      expectedFriendCode: null,
      cabinetUserId: identity.cabinetUserId,
      rivalName: identity.rivalName,
      computedRating: identity.rating,
      botUserFriendCode: identity.bot.friendCode,
      dxnetJobId: null,
      resolvedFriendCode: null,
      token: null,
      error: null,
    });
    this.logger.log(
      `QR-login slow path enqueued attemptId=${attemptId} cabinetUid=${identity.cabinetUserId} name=${identity.rivalName} rating=${identity.rating} bot=${identity.bot.friendCode}`,
    );

    // Fire and forget — FE polls.
    this.runSlowPath(attemptId, identity).catch((err) => {
      this.logger.error(
        `QR-login slow path attemptId=${attemptId} crashed: ${err instanceof Error ? err.message : err}`,
      );
      // Best effort: persist the failure so polling FE sees it.
      this.attemptModel
        .updateOne(
          { id: attemptId },
          {
            $set: {
              status: 'failed',
              error: err instanceof Error ? err.message : String(err),
            },
          },
        )
        .catch(() => {});
    });

    return { kind: 'async', attemptId };
  }

  /**
   * Background worker for the slow path. Updates the attempt row at
   * each step so the FE can render progress (and we can debug).
   */
  private async runSlowPath(
    attemptId: string,
    identity: PreparedCabinetIdentity,
  ): Promise<void> {
    const friendCode = await this.identityMatcher.resolveFriendCode(identity, {
      tagPrefix: 'qr-login',
      context: `QR-login attemptId=${attemptId}`,
      source: 'qr_login',
      onStage: (stage) => this.setAttemptStatus(attemptId, stage),
    });
    const placeholderProfile = {
      avatarUrl: null,
      title: null,
      titleColor: null,
      username: identity.rivalName,
      rating: identity.rating,
      ratingBgUrl: null,
      courseRankUrl: null,
      classRankUrl: null,
      awakeningCount: null,
    };
    const user = await this.findOrCreateQrUser(
      attemptId,
      friendCode,
      identity.cabinetUserId,
      placeholderProfile,
    );
    const signed = await this.auth.issueTokenForUser(user as never);
    await this.users
      .updateLastActiveAt(String(user._id))
      .catch(() => undefined);
    await this.setAttemptStatus(attemptId, 'matched', {
      resolvedFriendCode: friendCode,
      token: signed.token,
    });
  }

  private async setAttemptStatus(
    attemptId: string,
    status: QrLoginStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.attemptModel.updateOne(
      { id: attemptId, status: { $in: ACTIVE_ATTEMPT_STATUSES } },
      { $set: { status, ...extra } },
    );
  }

  private async findOrCreateQrUser(
    attemptId: string,
    friendCode: string,
    cabinetUserId: number,
    placeholderProfile: {
      username: string;
      rating: number;
      avatarUrl: null;
      title: null;
      titleColor: null;
      ratingBgUrl: null;
      courseRankUrl: null;
      classRankUrl: null;
      awakeningCount: null;
    },
  ) {
    let user = await this.users.findByFriendCode(friendCode);
    if (!user) {
      user = await this.users.create({
        friendCode,
        cabinetUserId,
        profile: placeholderProfile,
      });
      this.logger.log(
        `QR-login attemptId=${attemptId} created user fc=${friendCode} cabinetUid=${cabinetUserId}`,
      );
      return user;
    }
    const updates: Record<string, unknown> = {};
    if (
      (user as { cabinetUserId?: number | null }).cabinetUserId !==
      cabinetUserId
    ) {
      updates.cabinetUserId = cabinetUserId;
    }
    if (!(user as { profile?: unknown }).profile) {
      updates.profile = placeholderProfile;
    }
    if (Object.keys(updates).length > 0) {
      await this.users.update(String(user._id), updates);
      return (await this.users.findByFriendCode(friendCode))!;
    }
    return user;
  }

  /**
   * FE poll endpoint backing /auth/qr-login/:attemptId.
   */
  async pollAttempt(attemptId: string): Promise<QrLoginPollResult> {
    let doc = await this.attemptModel.findOne({ id: attemptId }).lean();
    if (!doc) {
      throw new Error('attempt not found');
    }
    if ((doc.purpose ?? 'login') !== 'login') {
      throw new Error('attempt is not a login attempt');
    }
    if (doc.status !== 'matched' && doc.status !== 'failed') {
      await this.advanceClaimAttemptWithLease(doc);
      doc = await this.attemptModel.findOne({ id: attemptId }).lean();
      if (!doc) {
        throw new Error('attempt not found');
      }
    }
    const result: QrLoginPollResult = {
      attemptId,
      status: doc.status,
      token: doc.token ?? null,
      error: doc.error ?? null,
    };
    if (doc.status === 'matched' && doc.resolvedFriendCode) {
      const u = await this.users.findByFriendCode(doc.resolvedFriendCode);
      if (u) {
        result.user = { ...u, id: String(u._id), friendCode: u.friendCode };
      }
    }
    return result;
  }

  async pollCabinetBindingAttempt(attemptId: string, ownerUserId: string) {
    let doc = await this.attemptModel
      .findOne({
        id: attemptId,
        purpose: 'cabinet_binding',
        ownerUserId,
      })
      .lean();
    if (!doc) {
      throw new Error('attempt not found');
    }
    if (doc.status !== 'matched' && doc.status !== 'failed') {
      await this.advanceClaimAttemptWithLease(doc);
      doc = await this.attemptModel
        .findOne({ id: attemptId, purpose: 'cabinet_binding', ownerUserId })
        .lean();
      if (!doc) {
        throw new Error('attempt not found');
      }
    }
    return {
      attemptId,
      status: doc.status,
      ...(doc.status === 'matched' ? { ok: true } : {}),
      error: doc.error ?? null,
    };
  }

  private async runClaimAttemptReconcile(): Promise<void> {
    if (this.reconcileRunning) {
      return;
    }
    this.reconcileRunning = true;
    try {
      const attempts = await this.attemptModel
        .find({
          dxnetJobId: { $type: 'string' },
          status: { $in: ACTIVE_ATTEMPT_STATUSES },
        })
        .sort({ updatedAt: 1 })
        .limit(ATTEMPT_RECONCILE_BATCH_SIZE)
        .lean<QrLoginAttemptEntity[]>();
      for (const attempt of attempts) {
        await this.advanceClaimAttemptWithLease(attempt).catch((error) => {
          this.logger.warn(
            `failed to reconcile identity attempt ${attempt.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    } catch (error) {
      this.logger.warn(
        `identity attempt reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.reconcileRunning = false;
    }
  }

  private async advanceClaimAttemptWithLease(
    attempt: QrLoginAttemptEntity,
  ): Promise<void> {
    await this.leases.run(
      {
        name: `qr-identity-attempt:${attempt.id}`,
        ttlMs: 15_000,
        renewEveryMs: 5_000,
        hardTimeoutMs: 30_000,
        abortGraceMs: 5_000,
      },
      ({ signal }) => this.advanceClaimAttempt(attempt, signal),
    );
  }

  private async advanceClaimAttempt(
    attempt: QrLoginAttemptEntity,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!attempt.dxnetJobId) {
      return;
    }
    signal?.throwIfAborted();
    const job = await this.jobs.getWorker(attempt.dxnetJobId);
    await this.syncClaimAttemptProgress(attempt, job);
    if (job.status === 'failed' || job.status === 'canceled') {
      await this.setAttemptStatus(attempt.id, 'failed', {
        error: job.error ?? 'DXNet identity job failed',
      });
      return;
    }
    if (job.status === 'completed') {
      await this.completeClaimAttempt(attempt, job, signal);
    }
  }

  private async syncClaimAttemptProgress(
    attempt: QrLoginAttemptEntity,
    job: WorkerJobView,
  ): Promise<void> {
    await this.attemptModel.updateOne(
      { id: attempt.id, status: { $in: ACTIVE_ATTEMPT_STATUSES } },
      {
        $set: {
          botUserFriendCode:
            job.botUserFriendCode ?? attempt.botUserFriendCode ?? null,
          status: this.claimAttemptStatus(job, attempt.status),
        },
      },
    );
  }

  private claimAttemptStatus(
    job: WorkerJobView,
    fallback: QrLoginStatus,
  ): QrLoginStatus {
    if (
      job.status === 'processing' &&
      (job.cabinetFriendshipStatus === 'pending' ||
        job.cabinetFriendshipStatus === 'running')
    ) {
      return 'adding_rival';
    }
    if (job.status === 'processing' || job.status === 'completed') {
      return 'waiting_snapshot';
    }
    return fallback;
  }

  private async completeClaimAttempt(
    attempt: QrLoginAttemptEntity,
    job: WorkerJobView,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const current = await this.attemptModel.findOne({ id: attempt.id }).lean();
    if (!current || !ACTIVE_ATTEMPT_STATUSES.includes(current.status)) {
      return;
    }
    const freshAfter = this.claimSnapshotFreshAfter(job);
    const resolved = await this.identityMatcher.resolveAttemptSnapshot(
      current,
      freshAfter,
    );
    if (resolved.kind === 'waiting') {
      const snapshotWaitStartedAt = Math.max(
        freshAfter.getTime(),
        new Date(job.updatedAt).getTime(),
      );
      if (Date.now() - snapshotWaitStartedAt > 90_000) {
        await this.setAttemptStatus(attempt.id, 'failed', {
          error: '未在超时时间内拿到可确认身份的好友列表快照',
        });
      }
      return;
    }
    if (resolved.kind === 'failed') {
      await this.setAttemptStatus(attempt.id, 'failed', {
        error: resolved.error,
      });
      return;
    }
    signal?.throwIfAborted();
    await this.completeResolvedClaim(current, resolved.friendCode);
  }

  private claimSnapshotFreshAfter(job: WorkerJobView): Date {
    const refreshTimestamp =
      job.result && typeof job.result === 'object'
        ? (job.result as { friendsUpdatedAt?: unknown }).friendsUpdatedAt
        : null;
    const parsed =
      typeof refreshTimestamp === 'string' ? new Date(refreshTimestamp) : null;
    return parsed && Number.isFinite(parsed.getTime())
      ? parsed
      : new Date(job.updatedAt);
  }

  private async completeResolvedClaim(
    current: QrLoginAttemptEntity,
    friendCode: string,
  ): Promise<void> {
    if (current.purpose === 'cabinet_binding') {
      await this.completeCabinetBindingClaim(current, friendCode);
      return;
    }
    const placeholderProfile = {
      avatarUrl: null,
      title: null,
      titleColor: null,
      username: current.rivalName,
      rating: current.computedRating,
      ratingBgUrl: null,
      courseRankUrl: null,
      classRankUrl: null,
      awakeningCount: null,
    };
    const user = await this.findOrCreateQrUser(
      current.id,
      friendCode,
      current.cabinetUserId,
      placeholderProfile as never,
    );
    const signed = await this.auth.issueTokenForUser(user as never);
    await this.users
      .updateLastActiveAt(String(user._id))
      .catch(() => undefined);
    await this.setAttemptStatus(current.id, 'matched', {
      resolvedFriendCode: friendCode,
      token: signed.token,
    });
  }

  private async completeCabinetBindingClaim(
    current: QrLoginAttemptEntity,
    friendCode: string,
  ): Promise<void> {
    if (friendCode !== current.expectedFriendCode) {
      await this.setAttemptStatus(current.id, 'failed', {
        error: '二维码反查出的好友码与当前登录账号不一致',
      });
      return;
    }
    if (!current.ownerUserId) {
      await this.setAttemptStatus(current.id, 'failed', {
        error: 'binding attempt has no owner',
      });
      return;
    }
    const bound = await this.users.bindCabinetUserIdIfUnbound(
      current.ownerUserId,
      current.cabinetUserId,
    );
    if (!bound) {
      await this.setAttemptStatus(current.id, 'failed', {
        error: '当前账号已绑定其他二维码，本次旧请求未覆盖现有绑定',
      });
      return;
    }
    await this.setAttemptStatus(current.id, 'matched', {
      resolvedFriendCode: friendCode,
    });
  }

  async getRunningRivalNames(): Promise<string[]> {
    const rows = await this.attemptModel
      .find({
        status: { $in: ACTIVE_ATTEMPT_STATUSES },
        rivalName: { $type: 'string', $ne: '' },
      })
      .select('rivalName')
      .lean();

    return [
      ...new Set(
        rows
          .map((row) => row.rivalName?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    ];
  }
}
