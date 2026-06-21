import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';

import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';

import { BotFriendSnapshotService } from '../admin/bot-friend-snapshot.service';
import { BotStatusService } from '../admin/bot-status.service';
import { MusicEntity } from '../music/music.schema';
import type { ChartPayload, MusicDocument } from '../music/music.schema';
import { SdgbJobDispatcher } from '../sdgb-worker/sdgb-job.dispatcher';
import { UsersService } from '../users/users.service';
import { getRating } from '../../common/rating';
import {
  QrLoginAttemptEntity,
  type QrLoginAttemptDocument,
  type QrLoginStatus,
} from './qr-login-attempt.schema';

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
 *      3. wait for bot friend snapshot from worker status report
 *      4. unique (name,rating) match in the snapshot → done
 */
@Injectable()
export class QrLoginService {
  private readonly logger = new Logger(QrLoginService.name);

  constructor(
    private readonly sdgb: SdgbJobDispatcher,
    private readonly users: UsersService,
    private readonly botStatus: BotStatusService,
    private readonly snapshot: BotFriendSnapshotService,
    private readonly jwt: JwtService,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
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

    let scan;
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

    const cabinetUserId = scan.cabinetUserId;
    const rivalName = scan.rivalName;

    // Fast path.
    const existing = await this.users.findByCabinetUserId(cabinetUserId);
    if (existing) {
      this.logger.log(
        `QR-login fast path: cabinetUid=${cabinetUserId} → friendCode=${existing.friendCode}`,
      );
      return { kind: 'fast', ...(await this.signFor(existing as never)) };
    }

    if (!rivalName) {
      throw new Error('cabinet did not return rival name; cannot match');
    }

    const myRating = await this.computeB50(scan.music);
    if (myRating == null) {
      throw new Error(
        '无法从机台成绩计算 rating（可能 music 表未同步），请稍后重试',
      );
    }

    // Pick a bot up-front so we can record it on the attempt and fail
    // fast if there isn't one.
    const bot = await this.botStatus.pickAvailableCabinetBot();
    if (!bot) {
      throw new Error(
        '当前没有可用的、配置了 cabinetUserId 的 bot，请稍后重试或使用 friendCode 登录',
      );
    }

    const attemptId = randomUUID();
    await this.attemptModel.create({
      id: attemptId,
      status: 'pending' as QrLoginStatus,
      cabinetUserId,
      rivalName,
      computedRating: myRating,
      botUserFriendCode: bot.friendCode,
      resolvedFriendCode: null,
      token: null,
      error: null,
    });
    this.logger.log(
      `QR-login slow path enqueued attemptId=${attemptId} cabinetUid=${cabinetUserId} name=${rivalName} rating=${myRating} bot=${bot.friendCode}`,
    );

    // Fire and forget — FE polls.
    this.runSlowPath(attemptId, cabinetUserId, rivalName, myRating, bot).catch(
      (err) => {
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
      },
    );

    return { kind: 'async', attemptId };
  }

  /**
   * Background worker for the slow path. Updates the attempt row at
   * each step so the FE can render progress (and we can debug).
   */
  private async runSlowPath(
    attemptId: string,
    cabinetUserId: number,
    rivalName: string,
    myRating: number,
    bot: { friendCode: string; cabinetUserId: number },
  ): Promise<void> {
    const setStatus = async (
      status: QrLoginStatus,
      extra: Record<string, unknown> = {},
    ) => {
      await this.attemptModel.updateOne(
        { id: attemptId },
        { $set: { status, ...extra } },
      );
    };

    // (1) addRival on the cabinet (instant + bidirectional).
    await setStatus('adding_rival');
    const rival = await this.sdgb.addRival(
      {
        botCabinetUserId: bot.cabinetUserId,
        targetCabinetUserId: cabinetUserId,
      },
      { tag: `qr-login-add:${cabinetUserId}`, timeoutMs: 60_000 },
    );
    const triggeredAt = new Date();
    this.logger.log(
      `QR-login attemptId=${attemptId} addRival rc1=${rival.returnCode1} rc2=${rival.returnCode2}`,
    );

    // (2) Wait for the bot status report to land a fresh snapshot
    // (`updatedAt > triggeredAt`), then look up (userName, rating) in it.
    await setStatus('waiting_snapshot');
    type Friend = {
      friendCode: string;
      userName: string | null;
      rating: number | null;
    };
    const SNAPSHOT_WAIT_DEADLINE_MS = 90_000;
    const SNAPSHOT_POLL_INTERVAL_MS = 2_000;
    const deadline = Date.now() + SNAPSHOT_WAIT_DEADLINE_MS;
    let snap = await this.snapshot.get(bot.friendCode);
    while (
      Date.now() < deadline &&
      (!snap?.updatedAt || snap.updatedAt.getTime() <= triggeredAt.getTime())
    ) {
      await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS));
      snap = await this.snapshot.get(bot.friendCode);
    }
    if (
      !snap ||
      !snap.updatedAt ||
      snap.updatedAt.getTime() <= triggeredAt.getTime()
    ) {
      throw new Error(
        '未在超时时间内拿到 bot 最新好友列表快照（worker 未上报），请稍后重试',
      );
    }
    const friends: Friend[] = snap.friends;
    this.logger.log(
      `QR-login attemptId=${attemptId} snapshot updatedAt=${snap.updatedAt.toISOString()} friends=${friends.length}`,
    );

    // (3) Match (userName, rating) inside the snapshot. Unique → win.
    const matches = friends.filter(
      (c) => c.userName === rivalName && c.rating === myRating,
    );
    if (matches.length === 0) {
      const sample = friends
        .slice(0, 5)
        .map((c) => `${c.friendCode}(${c.userName}|${c.rating})`)
        .join(', ');
      throw new Error(
        `bot 好友列表里未找到 name=${rivalName} rating=${myRating} 的记录 (sample: ${sample})`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `候选好友里找到 ${matches.length} 个 name=${rivalName} rating=${myRating} 的记录，请使用 friendCode 登录`,
      );
    }

    const friendCode = matches[0].friendCode;

    // (5) Find or create the User row, persist cabinetUserId so the
    // next QR login hits the fast path. Seed a placeholder profile.
    let user = await this.users.findByFriendCode(friendCode);
    const placeholderProfile = {
      avatarUrl: null,
      title: null,
      titleColor: null,
      username: rivalName,
      rating: myRating,
      ratingBgUrl: null,
      courseRankUrl: null,
      classRankUrl: null,
      awakeningCount: null,
    };
    if (!user) {
      user = await this.users.create({
        friendCode,
        cabinetUserId,
        profile: placeholderProfile,
      });
      this.logger.log(
        `QR-login attemptId=${attemptId} created user fc=${friendCode} cabinetUid=${cabinetUserId}`,
      );
    } else {
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
        user = (await this.users.findByFriendCode(friendCode))!;
      }
    }
    const signed = await this.signFor(user as never);
    // Mark the user active NOW so the dxnet worker's cleanup loop
    // (which evicts friends inactive > 1h) doesn't immediately drop the
    // friend we just added on the bot side. Without this, a
    // brand-new user can lose the bot-side friendship before they
    // ever finish syncing.
    await this.users
      .updateLastActiveAt(String(user._id))
      .catch(() => undefined);
    await setStatus('matched', {
      resolvedFriendCode: friendCode,
      token: signed.token,
    });
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

  /** Standard maimai b50: top 15 new + top 35 old, sum of per-row ratings. */
  private async computeB50(
    music: SdgbWorkerMusicEntry[],
  ): Promise<number | null> {
    const allMusic = (await this.musicModel.find().lean()) as Array<{
      id: string;
      isNew?: boolean | null;
      charts?: ChartPayload[];
    }>;
    const byNumericId = new Map<
      number,
      { isNew: boolean | null; charts: ChartPayload[] }
    >();
    for (const m of allMusic) {
      const num = Number(m.id);
      if (!Number.isFinite(num)) continue;
      byNumericId.set(num, { isNew: m.isNew ?? null, charts: m.charts ?? [] });
    }

    type Row = { isNew: boolean | null; rating: number };
    const rows: Row[] = [];
    for (const entry of music) {
      const meta = byNumericId.get(entry.musicId);
      if (!meta) continue;
      for (const detail of entry.userRivalMusicDetailList ?? []) {
        if (detail.level === 10) continue; // utage
        const chart = meta.charts[detail.level];
        const detailLevel = chart?.detailLevel ?? null;
        if (detailLevel == null) continue;
        const achv = detail.achievement / 10000;
        const rating = getRating(detailLevel, achv);
        if (!Number.isFinite(rating) || rating <= 0) continue;
        rows.push({ isNew: meta.isNew, rating });
      }
    }
    if (!rows.length) return null;

    const news = rows
      .filter((r) => r.isNew === true)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 15);
    const olds = rows
      .filter((r) => r.isNew === false)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 35);
    return (
      news.reduce((s, r) => s + r.rating, 0) +
      olds.reduce((s, r) => s + r.rating, 0)
    );
  }

  private async signFor(user: {
    _id: unknown;
    friendCode: string;
    [key: string]: unknown;
  }): Promise<{
    token: string;
    user: { id: string; friendCode: string; [key: string]: unknown };
  }> {
    const userId = String(user._id);
    const now = Math.floor(Date.now() / 1000);
    const token = await this.jwt.signAsync(
      { sub: userId, friendCode: user.friendCode, iat: now },
      { expiresIn: '30d' },
    );
    return {
      token,
      user: { ...user, id: userId, friendCode: user.friendCode },
    };
  }
}
