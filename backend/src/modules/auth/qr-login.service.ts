import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';

import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';

import { BotFriendSnapshotService } from '../admin/bot-friend-snapshot.service';
import { BotStatusService } from '../admin/bot-status.service';
import { MusicEntity } from '../music/music.schema';
import type { ChartPayload, MusicDocument } from '../music/music.schema';
import { SdgbJobDispatcher } from '../sdgb-worker/sdgb-job.dispatcher';
import { UsersService } from '../users/users.service';
import { getRating } from '../../common/rating';

const SNAPSHOT_POLL_INTERVAL_MS = 3_000;
const SNAPSHOT_TIMEOUT_MS = 90_000;

export interface QrLoginResult {
  token: string;
  user: { id: string; friendCode: string; [key: string]: unknown };
}

/**
 * QR-code login.
 *
 * Two paths:
 *  - FAST: user already has cabinetUserId bound → look them up directly,
 *    sign a token, done.
 *  - SLOW: brand-new user. Compute their b50 rating from sdgb's music
 *    response, ask one bot to addRival the cabinet user (UserFriendRegistApi
 *    is bidirectional and instant — no manual accept needed), then poll
 *    bot_friend_snapshots for a match on (rivalName, computed rating).
 *    Unique match → friendCode. Ambiguous → reject.
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
  ) {}

  async loginByQr(qrCode: string): Promise<QrLoginResult> {
    if (!qrCode || !qrCode.trim()) {
      throw new Error('qrCode required');
    }

    // (1) Resolve the QR to a cabinet userId + display name + music list.
    const scan = await this.sdgb.scanQr(
      { qrCode: qrCode.trim() },
      { tag: `qr-login`, timeoutMs: 120_000 },
    );
    const cabinetUserId = scan.cabinetUserId;
    const rivalName = scan.rivalName;

    // (2) Fast path: cabinetUserId already bound to a user.
    const existing = await this.users.findByCabinetUserId(cabinetUserId);
    if (existing) {
      this.logger.log(
        `QR-login fast path: cabinetUid=${cabinetUserId} → friendCode=${existing.friendCode}`,
      );
      return this.signFor(existing);
    }

    if (!rivalName) {
      throw new Error('cabinet did not return rival name; cannot match');
    }

    // (3) Compute the user's b50 rating from sdgb's music response.
    const myRating = await this.computeB50(scan.music);
    if (myRating == null) {
      throw new Error(
        '无法从机台成绩计算 rating（可能 music 表未同步），请稍后重试',
      );
    }
    this.logger.log(
      `QR-login slow path: cabinetUid=${cabinetUserId} name=${rivalName} computedRating=${myRating}`,
    );

    // (4) Pick a bot with a configured cabinetUserId.
    const bot = await this.botStatus.pickAvailableCabinetBot();
    if (!bot) {
      throw new Error(
        '当前没有可用的、配置了 cabinetUserId 的 bot，请稍后重试或使用 friendCode 登录',
      );
    }

    // (5) addRival is bidirectional + instant; no manual accept required.
    // Fire it and don't wait — the bot's friend list will reflect the new
    // friend after the worker re-fetches it. We also flag the bot for an
    // out-of-band friend list refresh so the worker re-fetches in seconds
    // instead of waiting up to 5 min for the next regular tick.
    this.sdgb
      .addRival(
        {
          botCabinetUserId: bot.cabinetUserId,
          targetCabinetUserId: cabinetUserId,
        },
        { tag: `qr-login-add:${cabinetUserId}`, timeoutMs: 120_000 },
      )
      .then(() => this.botStatus.requestFriendListRefresh(bot.friendCode))
      .catch((err) =>
        this.logger.warn(
          `QR-login addRival failed (continuing): ${err instanceof Error ? err.message : err}`,
        ),
      );

    // (6) Poll bot's snapshot for the (name, rating) match.
    const friendCode = await this.waitForMatch(
      bot.friendCode,
      rivalName,
      myRating,
    );

    // (7) Find or create the User row, persist cabinetUserId so next login
    // hits the fast path. Also seed a minimal profile (just username +
    // rating, no avatar) so the SPA's ProfileCard renders something
    // before the user runs a manual sync.
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
        `QR-login created new user friendCode=${friendCode} cabinetUid=${cabinetUserId}`,
      );
    } else {
      const updates: {
        cabinetUserId?: number;
        profile?: typeof placeholderProfile;
      } = {};
      if (
        (user as { cabinetUserId?: number | null }).cabinetUserId !==
        cabinetUserId
      ) {
        updates.cabinetUserId = cabinetUserId;
      }
      // Only seed placeholder profile when user has none yet — don't
      // overwrite a real DXNet-scraped profile.
      if (!(user as { profile?: unknown }).profile) {
        updates.profile = placeholderProfile;
      }
      if (Object.keys(updates).length > 0) {
        await this.users.update(String(user._id), updates);
        this.logger.log(
          `QR-login updated existing user friendCode=${friendCode} fields=${Object.keys(updates).join(',')}`,
        );
        user = (await this.users.findByFriendCode(friendCode))!;
      }
    }
    return this.signFor(user);
  }

  /** Standard maimai b50: top 15 new + top 35 old, sum of per-row ratings. */
  private async computeB50(
    music: SdgbWorkerMusicEntry[],
  ): Promise<number | null> {
    // Build cabinet → mongo lookup. cabinet uses numeric musicId; mongo
    // MusicEntity.id is a string like "11422" — Number(id) lets us cross-walk.
    // Fetch all music once (~1.5k rows, cheap) and bucket by numeric id.
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
        // chartIndex 10 (UTAGE) doesn't count toward b50.
        if (detail.level === 10) continue;
        const chartIndex = detail.level;
        const chart = meta.charts[chartIndex];
        const detailLevel = chart?.detailLevel ?? null;
        if (detailLevel == null) continue;
        const achv = detail.achievement / 10000; // cabinet stores ach × 10000
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

  private async waitForMatch(
    botFriendCode: string,
    userName: string,
    rating: number,
  ): Promise<string> {
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    let lastNotFoundLogged = false;
    while (Date.now() < deadline) {
      const res = await this.snapshot.findFriendByNameRating(
        botFriendCode,
        userName,
        rating,
      );
      if (res.kind === 'found') return res.friendCode;
      if (res.kind === 'ambiguous') {
        throw new Error(
          `bot 好友列表里有多名同名同 rating 用户(${res.matches} 条)，请改用 friendCode 登录`,
        );
      }
      if (!lastNotFoundLogged) {
        this.logger.log(
          `QR-login waiting on snapshot for bot=${botFriendCode} name=${userName} rating=${rating}`,
        );
        lastNotFoundLogged = true;
      }
      await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS));
    }
    throw new Error(
      '暂未在 bot 好友列表里找到该用户，请稍后重试或使用 friendCode 登录',
    );
  }

  private async signFor(user: {
    _id: unknown;
    friendCode: string;
  }): Promise<QrLoginResult> {
    const userId = String(user._id);
    const now = Math.floor(Date.now() / 1000);
    const token = await this.jwt.signAsync(
      { sub: userId, friendCode: user.friendCode, iat: now },
      { expiresIn: '30d' },
    );
    return {
      token,
      user: {
        ...(user as Record<string, unknown>),
        id: userId,
        friendCode: user.friendCode,
      },
    };
  }
}
