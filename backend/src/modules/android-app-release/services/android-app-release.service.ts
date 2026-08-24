import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AndroidAppReleaseChannelSchema,
  AndroidAppReleaseIdSchema,
  AndroidAppReleasePolicySchema,
  type AndroidAppReleaseEnvelope,
  type AndroidAppReleaseInfo,
  type AndroidAppReleaseLatestResponse,
  type AndroidAppReleaseManifest,
  type AndroidAppReleasePolicy,
} from '@maimai-score-hub/shared';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Model } from 'mongoose';

import {
  AndroidAppReleasePolicyEntity,
  type AndroidAppReleasePolicyDocument,
} from '../schemas/android-app-release-policy.schema';
import {
  AndroidAppReleaseEntity,
  type AndroidAppReleaseDocument,
} from '../schemas/android-app-release.schema';
import {
  decodeBase64Strict,
  getDownloadHost,
  isAndroidReleaseRolloutSelected,
  normalizeDownloadHost,
  parseSignedAndroidRelease,
} from './android-app-release.validation';

const HARD_MAX_APK_BYTES = 50 * 1024 * 1024;

type StoredApk = {
  path: string;
  size: number;
  sha256: string;
  apkUrl: string;
};

@Injectable()
export class AndroidAppReleaseService {
  private readonly releaseRoot: string;
  private readonly publicBaseUrl: string;
  private readonly uploadMaxBytes: number;

  constructor(
    @InjectModel(AndroidAppReleaseEntity.name)
    private readonly releaseModel: Model<AndroidAppReleaseDocument>,
    @InjectModel(AndroidAppReleasePolicyEntity.name)
    private readonly policyModel: Model<AndroidAppReleasePolicyDocument>,
    config: ConfigService,
  ) {
    this.releaseRoot = resolve(
      config.get<string>('ANDROID_RELEASES_DIR', 'android-releases'),
    );
    this.publicBaseUrl = config
      .get<string>(
        'ANDROID_RELEASE_PUBLIC_BASE_URL',
        process.env.NODE_ENV === 'production'
          ? 'https://api.maiscorehub.bakapiano.com/api/v1/android/app/releases'
          : 'http://localhost:9050/api/v1/android/app/releases',
      )
      .replace(/\/+$/, '');
    this.uploadMaxBytes = Math.min(
      HARD_MAX_APK_BYTES,
      positiveInt(
        config.get<string>('ANDROID_RELEASE_MAX_UPLOAD_BYTES'),
        HARD_MAX_APK_BYTES,
      ),
    );
  }

  async upsertPolicy(
    channelInput: string,
    input: unknown,
  ): Promise<AndroidAppReleasePolicy> {
    try {
      const channel = AndroidAppReleaseChannelSchema.parse(channelInput);
      const policy = AndroidAppReleasePolicySchema.parse(input);
      if (policy.channel !== channel) {
        throw new Error('Android release policy channel does not match path');
      }
      const publicKey = decodeBase64Strict(policy.manifestPublicKeyBase64);
      if (publicKey.length < 256) {
        throw new Error('Android release manifest public key is too short');
      }
      const normalized = {
        ...policy,
        certificateSha256: policy.certificateSha256.toLowerCase(),
        allowedDownloadHosts: Array.from(
          new Set(policy.allowedDownloadHosts.map(normalizeDownloadHost)),
        ).sort(),
      };
      await this.policyModel
        .findOneAndUpdate(
          { channel },
          { $set: normalized },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .exec();
      return normalized;
    } catch (error) {
      throw badRequest(error);
    }
  }

  async uploadApk(
    releaseIdInput: string,
    input: Readable,
    contentLength: number | null,
  ): Promise<StoredApk> {
    const releaseId = this.parseReleaseId(releaseIdInput);
    if (contentLength !== null && contentLength > this.uploadMaxBytes) {
      throw new BadRequestException('Android APK exceeds upload limit');
    }
    const existingRelease = await this.releaseModel
      .exists({ releaseId })
      .exec();
    if (existingRelease) {
      throw new ConflictException('Published Android release is immutable');
    }
    await mkdir(this.releaseRoot, { recursive: true });
    const target = this.apkPath(releaseId);
    const temporary = `${target}.upload-${process.pid}-${Date.now()}`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.uploadMaxBytes) {
          callback(new Error('Android APK exceeds upload limit'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        input,
        meter,
        createWriteStream(temporary, { flags: 'wx' }),
      );
      if (size <= 0) {
        throw new Error('Android APK upload is empty');
      }
      await rm(target, { force: true });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw badRequest(error);
    }
    return {
      path: target,
      size,
      sha256: hash.digest('hex'),
      apkUrl: this.apkUrl(releaseId),
    };
  }

  async publish(
    releaseIdInput: string,
    input: unknown,
  ): Promise<AndroidAppReleaseInfo> {
    const releaseId = this.parseReleaseId(releaseIdInput);
    const existing = await this.releaseModel
      .findOne({ releaseId })
      .lean()
      .exec();
    if (existing) {
      const envelope = input as Partial<AndroidAppReleaseEnvelope>;
      if (
        existing.manifestBase64 === envelope.manifestBase64 &&
        existing.signatureBase64 === envelope.signatureBase64
      ) {
        return this.toInfo(existing);
      }
      throw new ConflictException('Published Android release is immutable');
    }

    let manifest: AndroidAppReleaseManifest;
    let envelope: AndroidAppReleaseEnvelope;
    try {
      const unsigned = input as { manifestBase64?: unknown };
      if (typeof unsigned?.manifestBase64 !== 'string') {
        throw new Error('Android release envelope is missing manifest');
      }
      const rawManifest = JSON.parse(
        decodeBase64Strict(unsigned.manifestBase64).toString('utf8'),
      ) as { channel?: unknown };
      const channel = AndroidAppReleaseChannelSchema.parse(rawManifest.channel);
      const rawPolicy = await this.policyModel
        .findOne({ channel })
        .lean()
        .exec();
      if (!rawPolicy || !rawPolicy.enabled) {
        throw new Error('Android release channel policy is unavailable');
      }
      const policy = AndroidAppReleasePolicySchema.parse({
        channel: rawPolicy.channel,
        packageName: rawPolicy.packageName,
        certificateSha256: rawPolicy.certificateSha256,
        manifestPublicKeyBase64: rawPolicy.manifestPublicKeyBase64,
        allowedDownloadHosts: rawPolicy.allowedDownloadHosts,
        maxApkBytes: rawPolicy.maxApkBytes,
        enabled: rawPolicy.enabled,
      });
      ({ manifest, envelope } = parseSignedAndroidRelease(
        input,
        policy.manifestPublicKeyBase64,
      ));
      this.validateManifestAgainstPolicy(releaseId, manifest, policy);
      await this.validateStoredApk(manifest, policy.maxApkBytes);
    } catch (error) {
      throw badRequest(error);
    }

    try {
      const created = await this.releaseModel.create({
        ...manifest,
        publishedAt: new Date(manifest.publishedAt),
        ...envelope,
        revoked: false,
      });
      return this.toInfo(created.toObject());
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ConflictException(
          'Android release version or ID already exists',
        );
      }
      throw error;
    }
  }

  async getLatest(input: {
    channel: string;
    packageName: string;
    currentVersionCode: number;
    installationId: string;
  }): Promise<AndroidAppReleaseLatestResponse> {
    const policy = await this.policyModel
      .findOne({ channel: input.channel, packageName: input.packageName })
      .lean()
      .exec();
    if (!policy || !policy.enabled) {
      return { updateAvailable: false, release: null };
    }
    const candidates = await this.releaseModel
      .find({
        channel: input.channel,
        packageName: input.packageName,
        versionCode: { $gt: input.currentVersionCode },
        revoked: false,
      })
      .sort({ versionCode: -1 })
      .lean()
      .exec();
    const selected = candidates.find((candidate) =>
      isAndroidReleaseRolloutSelected(
        candidate.releaseId,
        input.installationId,
        candidate.rolloutPercent,
        candidate.mandatory,
      ),
    );
    return selected
      ? { updateAvailable: true, release: this.toInfo(selected) }
      : { updateAvailable: false, release: null };
  }

  async getManifest(
    releaseIdInput: string,
  ): Promise<AndroidAppReleaseEnvelope> {
    const releaseId = this.parseReleaseId(releaseIdInput);
    const release = await this.releaseModel
      .findOne({ releaseId, revoked: false })
      .lean()
      .exec();
    if (!release) {
      throw new NotFoundException('Android release not found');
    }
    return {
      manifestBase64: release.manifestBase64,
      signatureBase64: release.signatureBase64,
      signatureAlgorithm: 'SHA256withRSA',
    };
  }

  async getApk(releaseIdInput: string): Promise<StoredApk> {
    const releaseId = this.parseReleaseId(releaseIdInput);
    const release = await this.releaseModel
      .findOne({ releaseId, revoked: false })
      .lean()
      .exec();
    if (!release) {
      throw new NotFoundException('Android release not found');
    }
    const path = this.apkPath(releaseId);
    const file = await stat(path).catch(() => {
      throw new NotFoundException('Android release APK not found');
    });
    if (file.size !== release.apkSize) {
      throw new NotFoundException('Android release APK is unavailable');
    }
    return {
      path,
      size: file.size,
      sha256: release.apkSha256,
      apkUrl: release.apkUrl,
    };
  }

  async revoke(releaseIdInput: string): Promise<void> {
    const releaseId = this.parseReleaseId(releaseIdInput);
    const result = await this.releaseModel
      .updateOne({ releaseId }, { $set: { revoked: true } })
      .exec();
    if (result.matchedCount === 0) {
      throw new NotFoundException('Android release not found');
    }
  }

  createApkReadStream(path: string) {
    return createReadStream(path);
  }

  private validateManifestAgainstPolicy(
    releaseId: string,
    manifest: AndroidAppReleaseManifest,
    policy: AndroidAppReleasePolicy,
  ): void {
    if (manifest.releaseId !== releaseId) {
      throw new Error('Android release ID does not match path');
    }
    if (
      manifest.channel !== policy.channel ||
      manifest.packageName !== policy.packageName
    ) {
      throw new Error('Android release does not match channel policy');
    }
    if (manifest.certificateSha256 !== policy.certificateSha256) {
      throw new Error('Android release certificate does not match policy');
    }
    if (manifest.apkSize > policy.maxApkBytes) {
      throw new Error('Android release APK exceeds channel policy');
    }
    const allowed = new Set(
      policy.allowedDownloadHosts.map(normalizeDownloadHost),
    );
    const declared = manifest.downloadHosts.map(normalizeDownloadHost);
    if (!declared.includes(getDownloadHost(manifest.apkUrl))) {
      throw new Error(
        'Android release URL host is absent from signed host list',
      );
    }
    if (declared.some((host) => !allowed.has(host))) {
      throw new Error('Android release contains a disallowed download host');
    }
    if (manifest.apkUrl !== this.apkUrl(releaseId)) {
      throw new Error(
        'Android release URL does not match Backend APK endpoint',
      );
    }
  }

  private async validateStoredApk(
    manifest: AndroidAppReleaseManifest,
    maxBytes: number,
  ): Promise<void> {
    const path = this.apkPath(manifest.releaseId);
    const file = await stat(path);
    if (file.size !== manifest.apkSize || file.size > maxBytes) {
      throw new Error('Stored Android APK size does not match manifest');
    }
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    if (hash.digest('hex') !== manifest.apkSha256) {
      throw new Error('Stored Android APK hash does not match manifest');
    }
  }

  private toInfo(
    release: Pick<
      AndroidAppReleaseEntity,
      | 'releaseId'
      | 'channel'
      | 'packageName'
      | 'versionCode'
      | 'versionName'
      | 'requiredBridgeApiVersion'
      | 'apkSize'
      | 'mandatory'
      | 'rolloutPercent'
      | 'notes'
      | 'publishedAt'
    >,
  ): AndroidAppReleaseInfo {
    return {
      releaseId: release.releaseId,
      channel: release.channel as AndroidAppReleaseInfo['channel'],
      packageName: release.packageName,
      versionCode: release.versionCode,
      versionName: release.versionName,
      requiredBridgeApiVersion: release.requiredBridgeApiVersion,
      apkSize: release.apkSize,
      mandatory: release.mandatory,
      rolloutPercent: release.rolloutPercent,
      notes: release.notes,
      publishedAt: new Date(release.publishedAt).toISOString(),
    };
  }

  private parseReleaseId(value: string): string {
    try {
      return AndroidAppReleaseIdSchema.parse(value);
    } catch (error) {
      throw badRequest(error);
    }
  }

  private apkPath(releaseId: string): string {
    return resolve(this.releaseRoot, `${releaseId}.apk`);
  }

  private apkUrl(releaseId: string): string {
    return `${this.publicBaseUrl}/${releaseId}/apk`;
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function badRequest(error: unknown): BadRequestException {
  const message = error instanceof Error ? error.message : String(error);
  return new BadRequestException(message);
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}
