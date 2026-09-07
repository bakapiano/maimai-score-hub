import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BotPlayerQrControl,
  UpdateBotPlayerQrControlBody,
} from '@maimai-score-hub/shared';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';

import { RedisService } from '../../../common/redis/redis.service';

const REQUEST_TTL_SECONDS = 10 * 60;
const QR_RESULT_TTL_SECONDS = 10 * 60;
const KEY_PREFIX = 'android:player-qr:';

type ActiveStatus = 'requested' | 'processing' | 'completed' | 'failed';

interface StoredControl {
  version: 1;
  friendCode: string;
  requestId: string;
  status: ActiveStatus;
  requestedAt: string;
  requestExpiresAt: string;
  processingAt: string | null;
  completedAt: string | null;
  qrCodeEncrypted: string | null;
  qrExpiresAt: string | null;
  errorCode: string | null;
}

@Injectable()
export class BotPlayerQrControlService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const secret =
      config.get<string>('ANDROID_QR_CONTROL_KEY') ||
      config.get<string>('AUTH_JWT_SECRET') ||
      'maimai-score-hub-local-development-only';
    this.encryptionKey = createHash('sha256')
      .update('android-player-qr-control\0')
      .update(secret)
      .digest();
  }

  async request(friendCode: string): Promise<BotPlayerQrControl> {
    const now = new Date();
    const stored: StoredControl = {
      version: 1,
      friendCode,
      requestId: randomUUID(),
      status: 'requested',
      requestedAt: now.toISOString(),
      requestExpiresAt: new Date(
        now.getTime() + REQUEST_TTL_SECONDS * 1000,
      ).toISOString(),
      processingAt: null,
      completedAt: null,
      qrCodeEncrypted: null,
      qrExpiresAt: null,
      errorCode: null,
    };
    await this.redis.setJson(this.key(friendCode), stored, {
      ttlSeconds: REQUEST_TTL_SECONDS,
    });
    return this.toPublic(stored);
  }

  async get(friendCode: string): Promise<BotPlayerQrControl> {
    const stored = await this.redis.getJson<StoredControl>(
      this.key(friendCode),
    );
    return stored ? this.toPublic(stored) : this.idle(friendCode);
  }

  async update(
    friendCode: string,
    update: UpdateBotPlayerQrControlBody,
  ): Promise<BotPlayerQrControl> {
    const key = this.key(friendCode);
    const stored = await this.redis.getJson<StoredControl>(key);
    if (!stored) {
      throw new NotFoundException('Player QR request expired or missing');
    }
    if (stored.requestId !== update.requestId) {
      throw new ConflictException('Player QR request was replaced');
    }
    this.assertTransition(stored.status, update.status);

    const now = new Date();
    const next: StoredControl = {
      ...stored,
      status: update.status,
      processingAt:
        update.status === 'processing'
          ? now.toISOString()
          : stored.processingAt,
      completedAt:
        update.status === 'completed' || update.status === 'failed'
          ? now.toISOString()
          : stored.completedAt,
      qrCodeEncrypted:
        update.status === 'completed' && update.qrCode
          ? this.encrypt(update.qrCode)
          : stored.qrCodeEncrypted,
      qrExpiresAt:
        update.status === 'completed'
          ? (update.qrExpiresAt ??
            new Date(
              now.getTime() + QR_RESULT_TTL_SECONDS * 1000,
            ).toISOString())
          : stored.qrExpiresAt,
      errorCode:
        update.status === 'failed'
          ? (update.errorCode ?? 'QR_ACQUISITION_FAILED')
          : null,
    };
    const ttlSeconds =
      update.status === 'completed'
        ? this.resultTtlSeconds(next.qrExpiresAt)
        : Math.max(
            1,
            Math.ceil(
              (new Date(stored.requestExpiresAt).getTime() - Date.now()) / 1000,
            ),
          );
    // Fence the write as well as the initial read: another backend replica
    // may replace, complete or expire this request while the phone reports.
    const updated = await this.redis.compareAndSetJson(
      key,
      stored,
      next,
      ttlSeconds,
    );
    if (!updated) {
      throw new ConflictException('Player QR request changed or expired');
    }
    return this.toPublic(next);
  }

  private assertTransition(from: ActiveStatus, to: ActiveStatus): void {
    const allowed =
      (to === 'processing' &&
        (from === 'requested' || from === 'processing')) ||
      (to === 'completed' && (from === 'requested' || from === 'processing')) ||
      (to === 'failed' && (from === 'requested' || from === 'processing'));
    if (!allowed) {
      throw new ConflictException(
        `Player QR request cannot move from ${from} to ${to}`,
      );
    }
  }

  private toPublic(stored: StoredControl): BotPlayerQrControl {
    return {
      friendCode: stored.friendCode,
      requested:
        stored.status === 'requested' || stored.status === 'processing',
      requestId: stored.requestId,
      status: stored.status,
      requestedAt: stored.requestedAt,
      requestExpiresAt: stored.requestExpiresAt,
      processingAt: stored.processingAt,
      completedAt: stored.completedAt,
      qrCode: stored.qrCodeEncrypted
        ? this.decrypt(stored.qrCodeEncrypted)
        : null,
      qrExpiresAt: stored.qrExpiresAt,
      errorCode: stored.errorCode,
    };
  }

  private idle(friendCode: string): BotPlayerQrControl {
    return {
      friendCode,
      requested: false,
      requestId: null,
      status: 'idle',
      requestedAt: null,
      requestExpiresAt: null,
      processingAt: null,
      completedAt: null,
      qrCode: null,
      qrExpiresAt: null,
      errorCode: null,
    };
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private decrypt(envelope: string): string {
    const [version, ivValue, tagValue, ciphertextValue] = envelope.split('.');
    if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
      throw new Error('Invalid player QR encryption envelope');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(ivValue, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private resultTtlSeconds(qrExpiresAt: string | null): number {
    if (!qrExpiresAt) {
      return QR_RESULT_TTL_SECONDS;
    }
    const remaining = Math.ceil(
      (new Date(qrExpiresAt).getTime() - Date.now()) / 1000,
    );
    return Math.max(1, Math.min(QR_RESULT_TTL_SECONDS, remaining));
  }

  private key(friendCode: string): string {
    return this.redis.key(`${KEY_PREFIX}${friendCode}`);
  }
}
