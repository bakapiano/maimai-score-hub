import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { HydratedDocument } from 'mongoose';
import type {
  StatsCardState,
  StatsCardTheme,
  StatsCardDisplayPatch,
  StatsCardDisplay,
} from '@maimai-score-hub/shared';
import {
  DEFAULT_STATS_CARD_DISPLAY,
  StatsCardDisplaySchema,
} from '@maimai-score-hub/shared';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { UserEntity } from '../users/schemas/user.schema';
import { ByteLru } from './byte-lru';
import { StatsCardShare, StatsCardArtifact } from './stats-card.schemas';
import { StatsCardAssets } from './stats-card.assets';
import type { CardAssets } from './stats-card.assets';
import {
  publicStatsProfile,
  statsHash,
  visibleStatsProfile,
} from './stats-card.profile';
import type { PublicStatsProfile } from './stats-card.profile';
import { StatsCardRenderer } from './stats-card.renderer';

const compress = promisify(gzip);
type Share = HydratedDocument<StatsCardShare>;
export type StatsCardImage = { gzip: Buffer; etag: string };

@Injectable()
export class StatsCardService {
  private readonly cache = new ByteLru<StatsCardImage>(32 * 1024 * 1024, 1024);
  private readonly pending = new Map<string, Promise<StatsCardImage>>();

  constructor(
    @InjectModel(StatsCardShare.name)
    private readonly shares: Model<StatsCardShare>,
    @InjectModel(StatsCardArtifact.name)
    private readonly artifacts: Model<StatsCardArtifact>,
    @InjectModel(UserEntity.name) private readonly users: Model<UserEntity>,
    private readonly assets: StatsCardAssets,
    private readonly renderer: StatsCardRenderer,
  ) {}

  async state(userId: string): Promise<StatsCardState> {
    await this.profile(userId);
    return stateOf(await this.shares.findOne({ userId }).exec());
  }

  async enable(userId: string): Promise<StatsCardState> {
    await this.profile(userId);
    await this.ensureShare(userId);
    const changed = await this.shares
      .findOneAndUpdate(
        { userId, enabled: false },
        {
          $set: { enabled: true, code: randomBytes(24).toString('base64url') },
          $inc: { generation: 1 },
        },
        { new: true },
      )
      .exec();
    const share = changed ?? (await this.shares.findOne({ userId }).exec());
    await this.checkAccountAfterMutation(userId);
    return stateOf(share);
  }

  async updateDisplay(
    userId: string,
    patch: StatsCardDisplayPatch,
  ): Promise<StatsCardState> {
    await this.profile(userId);
    await this.ensureShare(userId);
    const fields = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => ['display.' + key, value]),
    );
    const share = await this.shares
      .findOneAndUpdate(
        { userId },
        { $set: fields, $inc: { generation: 1 } },
        { new: true },
      )
      .exec();
    if (!share) {
      throw unavailable();
    }
    await this.invalidate(share);
    this.cache.deletePrefix('preview:' + userId + ':');
    await this.checkAccountAfterMutation(userId);
    return stateOf(share);
  }

  private async ensureShare(userId: string): Promise<void> {
    try {
      await this.shares.updateOne(
        { userId },
        { $setOnInsert: { userId } },
        { upsert: true },
      );
    } catch (error) {
      if (!duplicate(error)) {
        throw error;
      }
    }
  }

  async rotate(userId: string): Promise<StatsCardState> {
    await this.profile(userId);
    const share = await this.shares
      .findOneAndUpdate(
        { userId, enabled: true },
        {
          $set: { code: randomBytes(24).toString('base64url') },
          $inc: { generation: 1 },
        },
        { new: true },
      )
      .exec();
    if (!share) {
      throw new NotFoundException('请先生成分享链接');
    }
    await this.invalidate(share);
    await this.checkAccountAfterMutation(userId);
    return stateOf(share);
  }

  async disable(userId: string): Promise<StatsCardState> {
    await this.profile(userId);
    const share = await this.shares
      .findOneAndUpdate(
        { userId, enabled: true },
        { $set: { enabled: false, code: null }, $inc: { generation: 1 } },
        { new: true },
      )
      .exec();
    if (share) {
      await this.invalidate(share);
    }
    return stateOf(share ?? (await this.shares.findOne({ userId }).exec()));
  }

  /** The caller first deletes the user. Subsequent public reads then fail closed. */
  async deleteForUser(userId: string): Promise<void> {
    const share = await this.shares.findOne({ userId }).exec();
    if (share) {
      this.cache.deletePrefix(String(share._id) + ':');
    }
    this.cache.deletePrefix('preview:' + userId + ':');
    await Promise.all([
      this.shares.deleteMany({ userId }),
      this.artifacts.deleteMany({ userId }),
    ]);
  }

  async preview(
    userId: string,
    theme: StatsCardTheme,
  ): Promise<StatsCardImage> {
    const share = await this.shares.findOne({ userId }).exec();
    const profile = visibleStatsProfile(
      await this.profile(userId),
      displayOf(share),
    );
    const assets = await this.assets.prepare(profile);
    const hash = this.contentHash(profile, assets, theme);
    const key = 'preview:' + userId + ':' + hash;
    const image =
      this.cache.get(key) ??
      (await this.renderOnce(key, async () => {
        const result = await this.render(profile, assets, theme);
        this.cache.set(key, result, result.gzip.length);
        return result;
      }));
    const current = await this.shares.findOne({ userId }).exec();
    const currentProfile = visibleStatsProfile(
      await this.profile(userId),
      displayOf(current),
    );
    if (
      (current?.generation ?? 0) !== (share?.generation ?? 0) ||
      statsHash(currentProfile) !== statsHash(profile)
    ) {
      throw new ServiceUnavailableException('资料或展示设置已更新，请重试');
    }
    return image;
  }

  async publicImage(
    code: string,
    theme: StatsCardTheme,
  ): Promise<StatsCardImage> {
    // Never consult the byte cache before checking the current authoritative share.
    const share = await this.shares.findOne({ code, enabled: true }).exec();
    if (!share) {
      throw unavailable();
    }
    const profile = visibleStatsProfile(
      await this.profile(share.userId),
      displayOf(share),
    );
    const assets = await this.assets.prepare(profile);
    const contentHash = this.contentHash(profile, assets, theme);
    const key = String(share._id) + ':' + share.generation + ':' + contentHash;
    let image = this.cache.get(key);
    if (!image) {
      image = await this.renderOnce(key, () =>
        this.loadOrRender(share, profile, assets, theme, contentHash),
      );
      this.cache.set(key, image, image.gzip.length);
    }
    // Also applies to cached images and conditional/HEAD requests.
    await this.assertCurrent(share, profile);
    return image;
  }

  private async loadOrRender(
    share: Share,
    profile: PublicStatsProfile,
    assets: CardAssets,
    theme: StatsCardTheme,
    contentHash: string,
  ): Promise<StatsCardImage> {
    const shareId = String(share._id);
    const previous = await this.artifacts
      .findOne({ shareId, theme })
      .select('+svgGzip')
      .exec();
    if (
      previous?.generation === share.generation &&
      previous.contentHash === contentHash &&
      previous.rendererVersion === this.renderer.version
    ) {
      return { gzip: Buffer.from(previous.svgGzip), etag: previous.etag };
    }
    const image = await this.render(profile, assets, theme);
    await this.assertCurrent(share, profile);
    const revision = randomUUID();
    const data = {
      shareId,
      userId: share.userId,
      theme,
      generation: share.generation,
      contentHash,
      rendererVersion: this.renderer.version,
      revision,
      svgGzip: image.gzip,
      etag: image.etag,
      generatedAt: new Date(),
    };
    if (previous) {
      await this.artifacts.updateOne(
        { _id: previous._id, revision: previous.revision },
        { $set: data },
      );
    } else {
      try {
        await this.artifacts.create(data);
      } catch (error) {
        if (!duplicate(error)) {
          throw error;
        }
      }
    }
    try {
      await this.assertCurrent(share, profile);
    } catch (error) {
      // Clean only this render, never a newer concurrent writer's artifact.
      await this.artifacts.deleteOne({ shareId, theme, revision });
      throw error;
    }
    return image;
  }

  private async render(
    profile: PublicStatsProfile,
    assets: CardAssets,
    theme: StatsCardTheme,
  ) {
    const svg = this.renderer.render(profile, assets, theme);
    return {
      gzip: await compress(svg, { level: 6 }),
      etag: 'W/"' + createHash('sha256').update(svg).digest('hex') + '"',
    };
  }

  private async renderOnce(
    key: string,
    work: () => Promise<StatsCardImage>,
  ): Promise<StatsCardImage> {
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    if (this.pending.size >= 4) {
      throw new ServiceUnavailableException('卡片生成繁忙，请稍后重试');
    }
    const promise = work().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  private contentHash(
    profile: PublicStatsProfile,
    assets: CardAssets,
    theme: StatsCardTheme,
  ) {
    return statsHash([this.renderer.version, profile, assets.signature, theme]);
  }

  private async profile(userId: string): Promise<PublicStatsProfile> {
    if (!Types.ObjectId.isValid(userId)) {
      throw unavailable();
    }
    const user = await this.users
      .findById(userId)
      .select('profile')
      .lean()
      .exec();
    if (!user) {
      throw unavailable();
    }
    return publicStatsProfile(user.profile);
  }

  private async assertCurrent(share: Share, profile: PublicStatsProfile) {
    const [exists, currentProfile] = await Promise.all([
      this.shares.exists({
        _id: share._id,
        code: share.code,
        generation: share.generation,
        enabled: true,
      }),
      this.profile(share.userId),
    ]);
    if (!exists) {
      throw unavailable();
    }
    if (
      statsHash(visibleStatsProfile(currentProfile, displayOf(share))) !==
      statsHash(profile)
    ) {
      throw new ServiceUnavailableException('资料已更新，请重试');
    }
  }

  private async checkAccountAfterMutation(userId: string) {
    try {
      await this.profile(userId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        await this.deleteForUser(userId);
      }
      throw error;
    }
  }

  private async invalidate(share: Share) {
    this.cache.deletePrefix(String(share._id) + ':');
    await this.artifacts.deleteMany({
      shareId: String(share._id),
      generation: { $lt: share.generation },
    });
  }
}

function stateOf(share: Share | null): StatsCardState {
  return {
    enabled: share?.enabled ?? false,
    code: share?.enabled ? share.code : null,
    updatedAt: share?.updatedAt?.toISOString() ?? null,
    display: displayOf(share),
  };
}
function displayOf(share: Share | null): StatsCardDisplay {
  // Pre-feature rows have no display object; preserve their original appearance.
  return StatsCardDisplaySchema.parse(
    Object.fromEntries(
      Object.entries(DEFAULT_STATS_CARD_DISPLAY).map(([key, value]) => [
        key,
        share?.display?.[key as keyof StatsCardDisplay] ?? value,
      ]),
    ),
  );
}
function unavailable() {
  return new NotFoundException('分享卡片不存在或已关闭');
}
function duplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
  );
}
