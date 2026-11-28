import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import type { AuthSessionSummary } from '@maimai-score-hub/shared';
import type { Model } from 'mongoose';
import { isValidObjectId, Types } from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';

import { RedisService } from '../../../common/redis/redis.service';
import { UsersService } from '../../users/services/users.service';
import {
  AuthSessionEntity,
  type AuthSessionDocument,
} from '../schemas/auth-session.schema';

export type SessionMeta = {
  userAgent?: string | null;
};

export type IssuedSessionPair = {
  token: string;
  refreshToken: string;
  sessionId: string;
};

type GraceEntry = {
  sid: string;
  token: string;
  refreshToken: string;
};

const DEFAULT_ACCESS_TOKEN_TTL = '7d';
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 180;
const ROTATION_GRACE_SECONDS = 30;
const MAX_USER_AGENT_LENGTH = 300;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function generateRawRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

function parseDurationToSeconds(raw: string, fallbackSeconds: number): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return parsed > 0 ? parsed : fallbackSeconds;
  }
  const match = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (!match) {
    return fallbackSeconds;
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === 's'
      ? 1
      : unit === 'm'
        ? 60
        : unit === 'h'
          ? 3600
          : 86_400;
  return amount > 0 ? amount * multiplier : fallbackSeconds;
}

function sanitizeUserAgent(userAgent?: string | null): string | null {
  if (!userAgent || typeof userAgent !== 'string') {
    return null;
  }
  const trimmed = userAgent.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, MAX_USER_AGENT_LENGTH);
}

export function parseDeviceLabel(userAgent?: string | null): string {
  if (!userAgent || !userAgent.trim()) {
    return '未知设备';
  }
  const ua = userAgent;

  let os = '';
  if (/iPhone/i.test(ua)) {
    os = 'iPhone';
  } else if (/iPad/i.test(ua)) {
    os = 'iPad';
  } else if (/Android/i.test(ua)) {
    os = 'Android';
  } else if (/Windows/i.test(ua)) {
    os = 'Windows';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    os = 'macOS';
  } else if (/CrOS/i.test(ua)) {
    os = 'Chromebook';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  let client = '';
  if (/MicroMessenger/i.test(ua)) {
    client = '微信';
  } else if (/QQ\//i.test(ua)) {
    client = 'QQ';
  } else if (/EdgA?\/|Edge\//i.test(ua)) {
    client = 'Edge';
  } else if (/Firefox\/|FxiOS\//i.test(ua)) {
    client = 'Firefox';
  } else if (/; wv\)/i.test(ua)) {
    client = 'App';
  } else if (/Chrome\/|CriOS\//i.test(ua)) {
    client = 'Chrome';
  } else if (/Safari\//i.test(ua)) {
    client = 'Safari';
  }

  if (os && client) {
    return `${os} · ${client}`;
  }
  return os || client || '未知设备';
}

@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);
  private readonly accessTokenTtl: string;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlMs: number;

  constructor(
    @InjectModel(AuthSessionEntity.name)
    private readonly sessionModel: Model<AuthSessionDocument>,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.accessTokenTtl =
      config.get<string>('AUTH_ACCESS_TOKEN_TTL')?.trim() ||
      DEFAULT_ACCESS_TOKEN_TTL;
    this.accessTokenTtlSeconds = parseDurationToSeconds(
      this.accessTokenTtl,
      7 * 86_400,
    );
    const configuredDays = Number(
      config.get<string>('AUTH_REFRESH_TOKEN_TTL_DAYS') ??
        DEFAULT_REFRESH_TOKEN_TTL_DAYS,
    );
    const days =
      Number.isFinite(configuredDays) && configuredDays >= 1
        ? configuredDays
        : DEFAULT_REFRESH_TOKEN_TTL_DAYS;
    this.refreshTokenTtlMs = days * 86_400 * 1000;
  }

  async createSession(
    userId: string,
    friendCode: string,
    meta: SessionMeta = {},
  ): Promise<IssuedSessionPair> {
    const ownerId = this.toObjectId(userId);
    const now = new Date();
    const rawRefreshToken = generateRawRefreshToken();
    const userAgent = sanitizeUserAgent(meta.userAgent);
    const deviceLabel = parseDeviceLabel(userAgent);

    const created = await this.sessionModel.create({
      userId: ownerId,
      tokenHash: sha256Hex(rawRefreshToken),
      previousTokenHash: null,
      rotatedAt: null,
      deviceLabel,
      userAgent,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + this.refreshTokenTtlMs),
      revokedAt: null,
    });

    const sessionId = String(created._id);
    const token = await this.signAccessToken(userId, friendCode, sessionId);
    return {
      token,
      refreshToken: rawRefreshToken,
      sessionId,
    };
  }

  async refreshSession(
    rawRefreshToken: string,
    meta: SessionMeta = {},
  ): Promise<{ token: string; refreshToken: string }> {
    const trimmed = rawRefreshToken.trim();
    if (!trimmed) {
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }

    const tokenHash = sha256Hex(trimmed);
    const cachedGrace = await this.readGraceEntry(tokenHash);
    if (cachedGrace) {
      if (await this.isSessionRevoked(cachedGrace.sid)) {
        throw new UnauthorizedException('登录状态已失效，请重新登录');
      }
      return {
        token: cachedGrace.token,
        refreshToken: cachedGrace.refreshToken,
      };
    }

    const now = new Date();
    const nextRefreshToken = generateRawRefreshToken();
    const nextHash = sha256Hex(nextRefreshToken);
    const nextExpiresAt = new Date(now.getTime() + this.refreshTokenTtlMs);
    const userAgent = sanitizeUserAgent(meta.userAgent);
    const updateFields: Record<string, unknown> = {
      tokenHash: nextHash,
      previousTokenHash: tokenHash,
      rotatedAt: now,
      lastUsedAt: now,
      expiresAt: nextExpiresAt,
    };
    if (userAgent) {
      updateFields.userAgent = userAgent;
      updateFields.deviceLabel = parseDeviceLabel(userAgent);
    }

    const rotated = await this.sessionModel
      .findOneAndUpdate(
        {
          tokenHash,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        { $set: updateFields },
        { new: true },
      )
      .lean();

    if (!rotated) {
      const racedGrace = await this.readGraceEntry(tokenHash);
      if (racedGrace && !(await this.isSessionRevoked(racedGrace.sid))) {
        return {
          token: racedGrace.token,
          refreshToken: racedGrace.refreshToken,
        };
      }

      const reused = await this.sessionModel
        .findOne({ previousTokenHash: tokenHash, revokedAt: null })
        .select('_id rotatedAt')
        .lean();
      if (reused) {
        const rotatedAgeMs = reused.rotatedAt
          ? now.getTime() - new Date(reused.rotatedAt).getTime()
          : Infinity;
        if (rotatedAgeMs > ROTATION_GRACE_SECONDS * 1000) {
          await this.revokeByIdInternal(reused._id);
          this.logger.warn(
            `Detected rotated refresh token reuse for session ${String(reused._id)}; session revoked.`,
          );
        }
      }
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }

    const sessionId = String(rotated._id);
    const userId = String(rotated.userId);
    let user: Awaited<ReturnType<UsersService['getById']>>;
    try {
      user = await this.users.getById(userId);
    } catch {
      await this.revokeByIdInternal(rotated._id);
      throw new UnauthorizedException('账号不存在或已删除');
    }

    const token = await this.signAccessToken(
      userId,
      user.friendCode,
      sessionId,
    );
    await this.writeGraceEntry(tokenHash, {
      sid: sessionId,
      token,
      refreshToken: nextRefreshToken,
    });
    this.users.updateLastActiveAt(userId).catch(() => {});

    return { token, refreshToken: nextRefreshToken };
  }

  async upgradeLegacyToken(
    payload: { sub?: string; friendCode?: string; sid?: string; exp?: number },
    rawAccessToken: string,
    meta: SessionMeta = {},
  ): Promise<{ token: string; refreshToken: string }> {
    if (!payload.sub || !payload.friendCode) {
      throw new UnauthorizedException('无效的登录凭证');
    }
    if (payload.sid) {
      throw new UnauthorizedException('当前凭证无需升级');
    }

    const legacyHash = sha256Hex(rawAccessToken.trim());
    const grace = await this.readLegacyGrace(legacyHash);
    if (grace) {
      if (await this.isSessionRevoked(grace.sid)) {
        throw new UnauthorizedException('登录状态已失效，请重新登录');
      }
      return { token: grace.token, refreshToken: grace.refreshToken };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const remainingSec = Math.max(
      60,
      payload.exp ? payload.exp - nowSec : 30 * 86_400,
    );
    const acquired = await this.acquireLegacyUpgradeMark(
      legacyHash,
      remainingSec,
    );
    if (!acquired) {
      const raced = await this.readLegacyGrace(legacyHash);
      if (raced && !(await this.isSessionRevoked(raced.sid))) {
        return { token: raced.token, refreshToken: raced.refreshToken };
      }
      throw new UnauthorizedException('旧登录凭证已升级，请重新登录');
    }

    let user: Awaited<ReturnType<UsersService['getById']>>;
    try {
      user = await this.users.getById(payload.sub);
    } catch {
      throw new UnauthorizedException('账号不存在或已删除');
    }

    const issued = await this.createSession(
      String(user._id),
      user.friendCode,
      meta,
    );
    await this.writeLegacyGrace(legacyHash, {
      sid: issued.sessionId,
      token: issued.token,
      refreshToken: issued.refreshToken,
    });
    this.users.updateLastActiveAt(String(user._id)).catch(() => {});
    return { token: issued.token, refreshToken: issued.refreshToken };
  }

  async logout(rawRefreshToken?: string, currentSid?: string) {
    const trimmed = rawRefreshToken?.trim();
    if (trimmed) {
      const hash = sha256Hex(trimmed);
      const found = await this.sessionModel
        .findOneAndUpdate(
          {
            $or: [{ tokenHash: hash }, { previousTokenHash: hash }],
            revokedAt: null,
          },
          { $set: { revokedAt: new Date() } },
          { new: true },
        )
        .select('_id')
        .lean();
      if (found) {
        await this.markSessionRevoked(String(found._id));
      }
      return { ok: true as const };
    }

    if (currentSid && isValidObjectId(currentSid)) {
      await this.revokeByIdInternal(new Types.ObjectId(currentSid));
    }
    return { ok: true as const };
  }

  async listSessions(
    userId: string,
    currentSid?: string,
  ): Promise<AuthSessionSummary[]> {
    const ownerId = this.toObjectId(userId);
    const now = new Date();
    const rows = await this.sessionModel
      .find({
        userId: ownerId,
        revokedAt: null,
        expiresAt: { $gt: now },
      })
      .sort({ lastUsedAt: -1 })
      .lean();

    return rows.map((row) => ({
      id: String(row._id),
      deviceLabel: row.deviceLabel,
      userAgent: row.userAgent ?? null,
      current: Boolean(currentSid && String(row._id) === currentSid),
      createdAt: new Date(row.createdAt).toISOString(),
      lastUsedAt: new Date(row.lastUsedAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const ownerId = this.toObjectId(userId);
    if (!isValidObjectId(sessionId)) {
      throw new NotFoundException('登录设备不存在');
    }
    const targetId = new Types.ObjectId(sessionId);
    const updated = await this.sessionModel
      .findOneAndUpdate(
        { _id: targetId, userId: ownerId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { new: true },
      )
      .select('_id')
      .lean();
    if (!updated) {
      throw new NotFoundException('登录设备不存在或已下线');
    }
    await this.markSessionRevoked(String(updated._id));
    return { ok: true as const };
  }

  async revokeOtherSessions(
    userId: string,
    keepSid?: string,
  ): Promise<{ ok: true; revokedCount: number }> {
    const ownerId = this.toObjectId(userId);
    const filter: Record<string, unknown> = {
      userId: ownerId,
      revokedAt: null,
    };
    if (keepSid && isValidObjectId(keepSid)) {
      filter._id = { $ne: new Types.ObjectId(keepSid) };
    }

    const targets = await this.sessionModel.find(filter).select('_id').lean();
    if (targets.length === 0) {
      return { ok: true as const, revokedCount: 0 };
    }

    const ids = targets.map((t) => t._id);
    const result = await this.sessionModel.updateMany(
      { _id: { $in: ids }, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    await Promise.all(
      ids.map((id) => this.markSessionRevoked(String(id))),
    );
    return { ok: true as const, revokedCount: result.modifiedCount ?? 0 };
  }

  async deleteAllForUser(userId: string): Promise<number> {
    if (!isValidObjectId(userId)) {
      return 0;
    }
    const ownerId = new Types.ObjectId(userId);
    const active = await this.sessionModel
      .find({ userId: ownerId, revokedAt: null })
      .select('_id')
      .lean();
    await Promise.all(
      active.map((row) => this.markSessionRevoked(String(row._id))),
    );
    const res = await this.sessionModel.deleteMany({ userId: ownerId });
    return res.deletedCount ?? 0;
  }

  async isSessionRevoked(sid: string): Promise<boolean> {
    try {
      const value = await this.redis.getJson<number>(this.revokedKey(sid));
      return value === 1;
    } catch (error) {
      this.logger.warn(
        `Failed to check Redis revocation for sid=${sid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async signAccessToken(
    userId: string,
    friendCode: string,
    sessionId: string,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return this.jwt.signAsync(
      {
        sub: userId,
        friendCode,
        sid: sessionId,
        typ: 'access',
        iat: now,
      },
      { expiresIn: this.accessTokenTtl as never },
    );
  }

  private async revokeByIdInternal(id: Types.ObjectId): Promise<void> {
    await this.sessionModel.updateOne(
      { _id: id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    await this.markSessionRevoked(String(id));
  }

  private async markSessionRevoked(sid: string): Promise<void> {
    try {
      await this.redis.setJson(this.revokedKey(sid), 1, {
        ttlSeconds: this.accessTokenTtlSeconds,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to write Redis revocation marker for sid=${sid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readGraceEntry(tokenHash: string): Promise<GraceEntry | null> {
    try {
      return await this.redis.getJson<GraceEntry>(this.graceKey(tokenHash));
    } catch {
      return null;
    }
  }

  private async writeGraceEntry(
    tokenHash: string,
    entry: GraceEntry,
  ): Promise<void> {
    try {
      await this.redis.setJson(this.graceKey(tokenHash), entry, {
        ttlSeconds: ROTATION_GRACE_SECONDS,
      });
    } catch {
      // Best-effort grace cache.
    }
  }

  private async readLegacyGrace(
    legacyHash: string,
  ): Promise<GraceEntry | null> {
    try {
      return await this.redis.getJson<GraceEntry>(
        this.legacyGraceKey(legacyHash),
      );
    } catch {
      return null;
    }
  }

  private async writeLegacyGrace(
    legacyHash: string,
    entry: GraceEntry,
  ): Promise<void> {
    try {
      await this.redis.setJson(this.legacyGraceKey(legacyHash), entry, {
        ttlSeconds: ROTATION_GRACE_SECONDS,
      });
    } catch {
      // Best-effort grace cache.
    }
  }

  private async acquireLegacyUpgradeMark(
    legacyHash: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      return await this.redis.setNx(
        this.legacyUsedKey(legacyHash),
        '1',
        ttlSeconds * 1000,
      );
    } catch {
      return true;
    }
  }

  private revokedKey(sid: string): string {
    return this.redis.key(`auth:revoked-sid:${sid}`);
  }

  private graceKey(tokenHash: string): string {
    return this.redis.key(`auth:rt:grace:${tokenHash}`);
  }

  private legacyGraceKey(legacyHash: string): string {
    return this.redis.key(`auth:legacy:grace:${legacyHash}`);
  }

  private legacyUsedKey(legacyHash: string): string {
    return this.redis.key(`auth:legacy:used:${legacyHash}`);
  }

  private toObjectId(id: string): Types.ObjectId {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid user id');
    }
    return new Types.ObjectId(id);
  }
}
