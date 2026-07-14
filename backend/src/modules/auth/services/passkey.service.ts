import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { isValidObjectId, Types } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type { PasskeySummary } from '@maimai-score-hub/shared';
import { RedisService } from '../../../common/redis/redis.service';
import { UsersService } from '../../users/services/users.service';
import { PasskeyCredentialEntity } from '../schemas/passkey-credential.schema';
import { AuthService } from './auth.service';

type PasskeyCeremony = {
  type: 'registration' | 'authentication';
  challenge: string;
  userId?: string;
  passwordUpdatedAt?: string | null;
};

type PasskeySummarySource = Pick<
  PasskeyCredentialEntity,
  'name' | 'transports' | 'deviceType' | 'backedUp' | 'createdAt' | 'lastUsedAt'
> & { _id: unknown };

const CEREMONY_TTL_SECONDS = 300;
const PASSKEY_LIMIT = 10;
const PUBLIC_RATE_LIMIT = 30;
const PASSWORD_FAILURE_LIMIT = 5;
const PASSWORD_FAILURE_TTL_SECONDS = 600;

function passkeyError(code: string, message: string) {
  return { code, message };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number(error.code) === 11000
  );
}

@Injectable()
export class PasskeyService {
  private readonly rpName: string;
  private readonly rpID: string;
  private readonly expectedOrigins: string[];

  constructor(
    @InjectModel(PasskeyCredentialEntity.name)
    private readonly credentialModel: Model<PasskeyCredentialEntity>,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const production = config.get<string>('NODE_ENV') === 'production';
    this.rpName = config.get<string>(
      'WEBAUTHN_RP_NAME',
      production ? 'maimai Score Hub' : 'maimai Score Hub (Local)',
    );
    this.rpID = config.get<string>(
      'WEBAUTHN_RP_ID',
      production ? 'maiscorehub.bakapiano.com' : 'localhost',
    );
    const defaultOrigin = production
      ? 'https://maiscorehub.bakapiano.com'
      : 'http://localhost:3001';
    this.expectedOrigins = config
      .get<string>('WEBAUTHN_ORIGINS', defaultOrigin)
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean);
    if (!this.rpID || this.expectedOrigins.length === 0) {
      throw new Error('WebAuthn RP ID and origins must be configured');
    }
  }

  async createAuthenticationOptions(clientIp: string) {
    await this.enforcePublicRateLimit(clientIp);
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
      timeout: 60_000,
    });
    const ceremonyId = await this.storeCeremony({
      type: 'authentication',
      challenge: options.challenge,
    });
    return { ceremonyId, options };
  }

  async verifyAuthentication(
    clientIp: string,
    ceremonyId: string,
    rawResponse: Record<string, unknown>,
  ) {
    await this.enforcePublicRateLimit(clientIp);
    const ceremony = await this.consumeCeremony(ceremonyId);
    if (ceremony.type !== 'authentication') {
      throw new BadRequestException(
        passkeyError('challenge_expired', '登录请求已过期，请重试'),
      );
    }

    const response = rawResponse as unknown as AuthenticationResponseJSON;
    const credentialId = typeof response.id === 'string' ? response.id : '';
    const credential = await this.credentialModel
      .findOne({ credentialId })
      .select('+publicKey');
    if (!credential?.publicKey) {
      throw this.invalidPasskey();
    }

    let user: Awaited<ReturnType<UsersService['getById']>>;
    try {
      user = await this.users.getById(String(credential.userId));
    } catch {
      throw this.invalidPasskey();
    }

    const returnedUserHandle = response.response?.userHandle;
    if (
      returnedUserHandle &&
      returnedUserHandle !==
        this.userHandle(String(user._id)).toString('base64url')
    ) {
      throw this.invalidPasskey();
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.expectedOrigins,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports as AuthenticatorTransportFuture[],
        },
      });
      if (
        !verification.verified ||
        !verification.authenticationInfo.userVerified
      ) {
        throw this.invalidPasskey();
      }

      const now = new Date();
      await this.credentialModel.updateOne(
        { _id: credential._id },
        {
          $max: { counter: verification.authenticationInfo.newCounter },
          $set: {
            backedUp: verification.authenticationInfo.credentialBackedUp,
            deviceType: verification.authenticationInfo.credentialDeviceType,
            lastUsedAt: now,
          },
        },
      );
      this.auth.updateLastActiveAt(String(user._id));
      return this.auth.issueTokenForUser(user as never);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw this.invalidPasskey();
    }
  }

  async list(userId: string): Promise<PasskeySummary[]> {
    const ownerId = this.objectId(userId);
    const rows = await this.credentialModel
      .find({ userId: ownerId })
      .sort({ createdAt: -1 })
      .lean();
    return rows.map((row) => this.toSummary(row));
  }

  async createRegistrationOptions(userId: string, password: string) {
    const passwordState = await this.verifyManagementPassword(userId, password);
    const ownerId = this.objectId(userId);
    const [user, credentials, count] = await Promise.all([
      this.users.getById(userId),
      this.credentialModel
        .find({ userId: ownerId })
        .select('credentialId transports')
        .lean(),
      this.credentialModel.countDocuments({ userId: ownerId }),
    ]);
    if (count >= PASSKEY_LIMIT) {
      throw new ConflictException(
        passkeyError('passkey_limit_reached', '最多只能创建 10 个网站密钥'),
      );
    }

    const accountName = this.accountName(
      user as unknown as Record<string, unknown>,
    );
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: new Uint8Array(this.userHandle(userId)),
      userName: accountName,
      userDisplayName: accountName,
      timeout: 60_000,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as AuthenticatorTransportFuture[],
      })),
    });
    const ceremonyId = await this.storeCeremony({
      type: 'registration',
      challenge: options.challenge,
      userId,
      passwordUpdatedAt: passwordState.passwordUpdatedAt?.toISOString() ?? null,
    });
    return { ceremonyId, options };
  }

  async verifyRegistration(
    userId: string,
    ceremonyId: string,
    name: string,
    rawResponse: Record<string, unknown>,
  ): Promise<PasskeySummary> {
    const ceremony = await this.consumeCeremony(ceremonyId);
    if (ceremony.type !== 'registration' || ceremony.userId !== userId) {
      throw new BadRequestException(
        passkeyError('challenge_expired', '创建请求已过期，请重试'),
      );
    }

    const user = await this.users.getById(userId);
    const currentPasswordUpdatedAt = user.passwordUpdatedAt
      ? new Date(user.passwordUpdatedAt).toISOString()
      : null;
    if (currentPasswordUpdatedAt !== (ceremony.passwordUpdatedAt ?? null)) {
      throw new BadRequestException(
        passkeyError('challenge_expired', '密码已变更，请重新创建网站密钥'),
      );
    }

    const ownerId = this.objectId(userId);
    if (
      (await this.credentialModel.countDocuments({ userId: ownerId })) >=
      PASSKEY_LIMIT
    ) {
      throw new ConflictException(
        passkeyError('passkey_limit_reached', '最多只能创建 10 个网站密钥'),
      );
    }

    const response = rawResponse as unknown as RegistrationResponseJSON;
    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: this.expectedOrigins,
        expectedRPID: this.rpID,
        requireUserPresence: true,
        requireUserVerification: true,
      });
      if (
        !verification.verified ||
        !verification.registrationInfo.userVerified
      ) {
        throw new Error('Registration was not verified');
      }

      const info = verification.registrationInfo;
      const created = await this.credentialModel.create({
        userId: ownerId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports:
          info.credential.transports ?? response.response.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name: name.trim(),
        lastUsedAt: null,
      });
      return this.toSummary(created);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(
          passkeyError('passkey_already_registered', '该网站密钥已经绑定'),
        );
      }
      if (error instanceof HttpException) {
        throw error;
      }
      throw new BadRequestException(
        passkeyError('invalid_passkey', '网站密钥创建失败，请重试'),
      );
    }
  }

  async rename(
    userId: string,
    id: string,
    name: string,
  ): Promise<PasskeySummary> {
    const ownerId = this.objectId(userId);
    const credentialObjectId = this.objectId(id);
    const updated = await this.credentialModel.findOneAndUpdate(
      { _id: credentialObjectId, userId: ownerId },
      { $set: { name: name.trim() } },
      { new: true },
    );
    if (!updated) {
      throw new NotFoundException(
        passkeyError('passkey_not_found', '网站密钥不存在'),
      );
    }
    return this.toSummary(updated);
  }

  async delete(userId: string, id: string, password: string) {
    const ownerId = this.objectId(userId);
    const credentialObjectId = this.objectId(id);
    const exists = await this.credentialModel.exists({
      _id: credentialObjectId,
      userId: ownerId,
    });
    if (!exists) {
      throw new NotFoundException(
        passkeyError('passkey_not_found', '网站密钥不存在'),
      );
    }
    await this.verifyManagementPassword(userId, password);
    const result = await this.credentialModel.deleteOne({
      _id: credentialObjectId,
      userId: ownerId,
    });
    if (!result.deletedCount) {
      throw new NotFoundException(
        passkeyError('passkey_not_found', '网站密钥不存在'),
      );
    }
    return { ok: true as const };
  }

  private async verifyManagementPassword(userId: string, password: string) {
    const rateKey = this.passwordRateKey(userId);
    const failures = (await this.redis.getJson<number>(rateKey)) ?? 0;
    if (failures >= PASSWORD_FAILURE_LIMIT) {
      throw this.rateLimitError('密码验证失败次数过多，请稍后再试');
    }

    const state = await this.users.verifyAccountPassword(userId, password);
    if (!state.hasPassword) {
      throw new ConflictException(
        passkeyError('password_required', '请先设置账号密码'),
      );
    }
    if (!state.valid) {
      await this.redis.incrementWithExpiry(
        rateKey,
        PASSWORD_FAILURE_TTL_SECONDS,
      );
      throw new ForbiddenException(
        passkeyError('invalid_password', '当前密码不正确'),
      );
    }
    await this.redis.del(rateKey);
    return state;
  }

  private async enforcePublicRateLimit(clientIp: string) {
    const ipHash = createHash('sha256')
      .update(clientIp || 'unknown')
      .digest('hex')
      .slice(0, 24);
    const bucket = Math.floor(Date.now() / 60_000);
    const count = await this.redis.incrementWithExpiry(
      this.redis.key(`rate:webauthn:public:${ipHash}:${bucket}`),
      120,
    );
    if (count > PUBLIC_RATE_LIMIT) {
      throw this.rateLimitError('请求过于频繁，请稍后再试');
    }
  }

  private async storeCeremony(ceremony: PasskeyCeremony): Promise<string> {
    const ceremonyId = randomUUID();
    await this.redis.setJson(this.ceremonyKey(ceremonyId), ceremony, {
      ttlSeconds: CEREMONY_TTL_SECONDS,
    });
    return ceremonyId;
  }

  private async consumeCeremony(ceremonyId: string): Promise<PasskeyCeremony> {
    const ceremony = await this.redis.getDelJson<PasskeyCeremony>(
      this.ceremonyKey(ceremonyId),
    );
    if (!ceremony) {
      throw new BadRequestException(
        passkeyError('challenge_expired', '请求已过期，请重试'),
      );
    }
    return ceremony;
  }

  private ceremonyKey(ceremonyId: string): string {
    return this.redis.key(`webauthn:ceremony:${ceremonyId}`);
  }

  private passwordRateKey(userId: string): string {
    return this.redis.key(`rate:webauthn:password:${userId}`);
  }

  private accountName(user: Record<string, unknown>): string {
    if (typeof user.username === 'string' && user.username) {
      return user.username;
    }
    const profile = user.profile as { username?: unknown } | undefined;
    if (typeof profile?.username === 'string' && profile.username) {
      return profile.username;
    }
    const friendCode =
      typeof user.friendCode === 'string' ? user.friendCode : '';
    return friendCode
      ? `玩家 ····${friendCode.slice(-4)}`
      : `玩家 ${String(user._id).slice(-4)}`;
  }

  private userHandle(userId: string): Buffer {
    if (!/^[0-9a-fA-F]{24}$/.test(userId)) {
      throw new BadRequestException('Invalid user id');
    }
    return Buffer.from(userId, 'hex');
  }

  private objectId(id: string): Types.ObjectId {
    if (!isValidObjectId(id)) {
      throw new NotFoundException(
        passkeyError('passkey_not_found', '网站密钥不存在'),
      );
    }
    return new Types.ObjectId(id);
  }

  private toSummary(credential: PasskeySummarySource): PasskeySummary {
    return {
      id: String(credential._id),
      name: credential.name,
      transports: credential.transports ?? [],
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      createdAt: new Date(credential.createdAt).toISOString(),
      lastUsedAt: credential.lastUsedAt
        ? new Date(credential.lastUsedAt).toISOString()
        : null,
    };
  }

  private invalidPasskey(): UnauthorizedException {
    return new UnauthorizedException(
      passkeyError('invalid_passkey', 'Passkey 登录失败'),
    );
  }

  private rateLimitError(message: string): HttpException {
    return new HttpException(
      passkeyError('rate_limited', message),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
