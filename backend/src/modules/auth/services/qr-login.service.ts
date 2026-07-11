import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
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
export class QrLoginService {
  private readonly logger = new Logger(QrLoginService.name);

  constructor(
    private readonly sdgb: SdgbJobDispatcher,
    private readonly users: UsersService,
    private readonly identityMatcher: CabinetIdentityMatcherService,
    private readonly jwt: JwtService,
    @InjectModel(QrLoginAttemptEntity.name)
    private readonly attemptModel: Model<QrLoginAttemptDocument>,
  ) {}

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
      return { kind: 'fast', ...(await this.signFor(existing as never)) };
    }

    const identity = await this.identityMatcher.prepare(scan);

    const attemptId = randomUUID();
    await this.attemptModel.create({
      id: attemptId,
      status: 'pending' as QrLoginStatus,
      cabinetUserId: identity.cabinetUserId,
      rivalName: identity.rivalName,
      computedRating: identity.rating,
      botUserFriendCode: identity.bot.friendCode,
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
    const signed = await this.signFor(user as never);
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
      { id: attemptId },
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
    const doc = await this.attemptModel.findOne({ id: attemptId }).lean();
    if (!doc) {
      throw new Error('attempt not found');
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

  async getRunningRivalNames(): Promise<string[]> {
    const runningStatuses: QrLoginStatus[] = [
      'pending',
      'adding_rival',
      'waiting_snapshot',
    ];
    const rows = await this.attemptModel
      .find({
        status: { $in: runningStatuses },
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

  private async signFor(user: {
    _id: unknown;
    friendCode: string;
    [key: string]: unknown;
  }): Promise<{
    token: string;
    user: { id: string; friendCode: string; [key: string]: unknown };
  }> {
    const safeUser = { ...user };
    delete safeUser.passwordHash;
    delete safeUser.divingFishImportToken;
    delete safeUser.lxnsImportToken;
    delete safeUser.cabinetUserId;
    const userId = String(user._id);
    const now = Math.floor(Date.now() / 1000);
    const token = await this.jwt.signAsync(
      { sub: userId, friendCode: user.friendCode, iat: now },
      { expiresIn: '30d' },
    );
    return {
      token,
      user: { ...safeUser, id: userId, friendCode: user.friendCode },
    };
  }
}
