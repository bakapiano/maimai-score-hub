import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { loadImage } from '@napi-rs/canvas';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { CoverService } from '../cover/cover.service';
import { MusicEntity } from '../music/music.schema';
import type { ChartPayload, MusicDocument } from '../music/music.schema';
import { SyncEntity } from '../sync/sync.schema';
import type { SyncDocument, SyncScore } from '../sync/sync.schema';
import { UsersService } from '../users/users.service';
import type { UserNetProfile } from '../users/user.types';
import { ensureFontsLoaded } from './rendering/score-export.fonts';
import {
  buildLevelBuckets,
  buildRatingSummary,
  buildVersionBuckets,
} from './score-export.buckets';
import type {
  ChartEntry,
  CompactCard,
  MusicRow,
  PlatePlan,
  VersionBucket,
} from './score-export.types';
import {
  renderBest50Image,
  renderLevelScoresImage,
  renderVersionScoresImage,
} from './rendering/score-export.render';

@Injectable()
export class ScoreExportService {
  private readonly iconCache = new Map<
    string,
    Awaited<ReturnType<typeof loadImage>> | null
  >();

  constructor(
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncDocument>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
    private readonly covers: CoverService,
    private readonly users: UsersService,
  ) {}

  async generateBest50Image(friendCode: string): Promise<Buffer> {
    ensureFontsLoaded();
    const { scores, musicMap, chartMap } = await this.loadData(friendCode);
    const summary = buildRatingSummary(scores);
    if (!summary) {
      throw new NotFoundException('No rating data');
    }

    // Load user profile for header display
    let profile: UserNetProfile | null = null;
    try {
      const user = await this.users.findByFriendCode(friendCode);
      profile = user?.profile ?? null;
    } catch {
      // Profile is optional, continue without it
    }

    const newCards = summary.newTop.map((score) =>
      this.buildCompactCard(score, musicMap, chartMap),
    );
    const oldCards = summary.oldTop.map((score) =>
      this.buildCompactCard(score, musicMap, chartMap),
    );

    return renderBest50Image(
      {
        total: summary.totalSum,
        newSum: summary.newSum,
        oldSum: summary.oldSum,
        newCards,
        oldCards,
        profile,
      },
      (musicId) => this.loadCoverImage(musicId),
      (url) => this.loadRemoteImage(url),
    );
  }

  async generateLevelScoresImage(
    friendCode: string,
    levelKey?: string,
  ): Promise<Buffer> {
    ensureFontsLoaded();
    const { scores, musics } = await this.loadData(friendCode, true);
    const filteredMusics = musics.filter((m) => m.type !== 'utage');
    const filteredScores = scores.filter((s) => s.type !== 'utage');
    const buckets = buildLevelBuckets(filteredMusics, filteredScores);
    if (!buckets.length) {
      throw new NotFoundException('No level data');
    }

    const current = buckets.find((b) => b.levelKey === levelKey) ?? buckets[0];

    // Load user profile for header display
    let profile: UserNetProfile | null = null;
    try {
      const user = await this.users.findByFriendCode(friendCode);
      profile = user?.profile ?? null;
    } catch {
      // Profile is optional, continue without it
    }

    const rating = profile?.rating ?? 0;

    return renderLevelScoresImage(
      current,
      levelKey ?? current.levelKey,
      profile,
      rating,
      (musicId) => this.loadCoverImage(musicId),
      (url) => this.loadRemoteImage(url),
    );
  }

  async generateVersionScoresImage(
    friendCode: string,
    versionKey?: string,
    minLevel?: number,
    plan: PlatePlan = 'jiang',
  ): Promise<Buffer> {
    ensureFontsLoaded();
    const { scores, musics } = await this.loadData(friendCode, true);
    const filteredMusics = musics.filter((m) => m.type !== 'utage');
    const filteredScores = scores.filter((s) => s.type !== 'utage');
    const buckets = buildVersionBuckets(filteredMusics, filteredScores);
    if (!buckets.length) {
      throw new NotFoundException('No version data');
    }

    let current: VersionBucket;

    if (versionKey === '__mai__') {
      // 舞代: merge all legacy versions (maimai → FiNALE)
      const legacyVersions = new Set([
        'maimai',
        'maimai+',
        'green',
        'green+',
        'orange',
        'orange+',
        'pink',
        'pink+',
        'murasaki',
        'murasaki+',
        'milk',
        'milk+',
        'finale',
      ]);
      const legacyBuckets = buckets.filter((b) =>
        legacyVersions.has(b.versionKey),
      );
      const mergedLevelMap = new Map<
        string,
        { items: ChartEntry[]; levelNumeric: number | null }
      >();
      for (const bucket of legacyBuckets) {
        for (const level of bucket.levels) {
          const existing = mergedLevelMap.get(level.levelKey);
          if (existing) {
            existing.items.push(...level.items);
          } else {
            mergedLevelMap.set(level.levelKey, {
              items: [...level.items],
              levelNumeric: level.levelNumeric,
            });
          }
        }
      }
      current = {
        versionKey: '__mai__',
        levels: Array.from(mergedLevelMap.entries())
          .map(([levelKey, { items, levelNumeric }]) => ({
            levelKey,
            levelNumeric,
            items: items.sort((a, b) => {
              const aDs =
                typeof a.chart?.detailLevel === 'number'
                  ? a.chart.detailLevel
                  : -Infinity;
              const bDs =
                typeof b.chart?.detailLevel === 'number'
                  ? b.chart.detailLevel
                  : -Infinity;
              return bDs - aDs;
            }),
          }))
          .sort(
            (a, b) =>
              (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity),
          ),
      };
    } else {
      // Merge groups that share a plate (e.g. maimai + maimai+ → 真代)
      const MERGE_MAP: Record<string, string[]> = {
        maimai: ['maimai', 'maimai+'],
      };
      const mergeVersions = MERGE_MAP[versionKey ?? ''];
      if (mergeVersions) {
        const mergeBuckets = buckets.filter((b) =>
          mergeVersions.includes(b.versionKey),
        );
        const mergedLevelMap = new Map<
          string,
          { items: ChartEntry[]; levelNumeric: number | null }
        >();
        for (const bucket of mergeBuckets) {
          for (const level of bucket.levels) {
            const existing = mergedLevelMap.get(level.levelKey);
            if (existing) {
              existing.items.push(...level.items);
            } else {
              mergedLevelMap.set(level.levelKey, {
                items: [...level.items],
                levelNumeric: level.levelNumeric,
              });
            }
          }
        }
        current = {
          versionKey: versionKey!,
          levels: Array.from(mergedLevelMap.entries())
            .map(([levelKey, { items, levelNumeric }]) => ({
              levelKey,
              levelNumeric,
              items: items.sort((a, b) => {
                const aDs =
                  typeof a.chart?.detailLevel === 'number'
                    ? a.chart.detailLevel
                    : -Infinity;
                const bDs =
                  typeof b.chart?.detailLevel === 'number'
                    ? b.chart.detailLevel
                    : -Infinity;
                return bDs - aDs;
              }),
            }))
            .sort(
              (a, b) =>
                (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity),
            ),
        };
      } else {
        current =
          buckets.find((b) => b.versionKey === versionKey) ?? buckets[0];
      }
    }

    // Filter by minLevel if specified
    if (minLevel !== undefined && !isNaN(minLevel)) {
      current = {
        ...current,
        levels: current.levels
          .map((level) => ({
            ...level,
            items: level.items.filter((item) => {
              const detailLevel = item.chart?.detailLevel;
              if (typeof detailLevel === 'number') {
                return detailLevel >= minLevel;
              }
              // Fallback to parsing level string
              const levelNum = level.levelNumeric;
              return levelNum !== null && levelNum >= minLevel;
            }),
          }))
          .filter((level) => level.items.length > 0),
      };
    }

    // Filter out Re:Master (chartIndex=4) for non-舞代 versions
    // 舞代 (__mai__) includes Re:Master; individual versions don't
    if (versionKey !== '__mai__') {
      current = {
        ...current,
        levels: current.levels
          .map((level) => ({
            ...level,
            items: level.items.filter((item) => item.chartIndex !== 4),
          }))
          .filter((level) => level.items.length > 0),
      };
    }

    // Load user profile for header display
    let profile: UserNetProfile | null = null;
    try {
      const user = await this.users.findByFriendCode(friendCode);
      profile = user?.profile ?? null;
    } catch {
      // Profile is optional, continue without it
    }

    const rating = profile?.rating ?? 0;

    return renderVersionScoresImage(
      current,
      versionKey ?? current.versionKey,
      profile,
      rating,
      plan,
      (musicId) => this.loadCoverImage(musicId),
      (url) => this.loadRemoteImage(url),
    );
  }

  async generateImagesForFriendCode(
    friendCode: string,
    outputDir: string,
  ): Promise<{ dir: string }> {
    const dir = outputDir || join(process.cwd(), 'score-exports');
    await mkdir(dir, { recursive: true });

    const best50 = await this.generateBest50Image(friendCode);
    const levelBuckets = await this.generateLevelScoresImage(friendCode);
    const versionBuckets = await this.generateVersionScoresImage(friendCode);

    await writeFile(join(dir, 'best50.png'), best50);
    await writeFile(join(dir, 'level.png'), levelBuckets);
    await writeFile(join(dir, 'version.png'), versionBuckets);

    return { dir };
  }

  private async loadData(friendCode: string, includeMusics = true) {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .sort({ createdAt: -1 })
      .lean();

    if (!sync) {
      throw new NotFoundException('No sync found');
    }

    const scores: SyncScore[] = Array.isArray(sync.scores) ? sync.scores : [];
    if (!scores.length) {
      throw new NotFoundException('No scores found');
    }

    const musics = includeMusics
      ? ((await this.musicModel.find().lean()) as MusicRow[])
      : ([] as MusicRow[]);

    const musicMap = new Map<string, MusicRow>();
    const chartMap = new Map<string, ChartPayload>();
    for (const music of musics) {
      musicMap.set(music.id, music);
      const charts = music.charts ?? [];
      for (const chart of charts) {
        if (typeof chart.cid === 'string') {
          chartMap.set(chart.cid, chart);
        }
      }
    }

    return { scores, musics, musicMap, chartMap };
  }

  private buildCompactCard(
    score: SyncScore,
    musicMap: Map<string, MusicRow>,
    chartMap: Map<string, ChartPayload>,
  ): CompactCard {
    const music = musicMap.get(score.musicId);
    const chart =
      typeof score.cid === 'string' ? chartMap.get(score.cid) : null;
    const detailLevelText =
      typeof chart?.detailLevel === 'number'
        ? chart.detailLevel.toFixed(1)
        : (chart?.detailLevel ?? chart?.level ?? '?');

    return {
      musicId: score.musicId,
      chartIndex: score.chartIndex,
      type: score.type,
      score: score.score ?? null,
      rating: score.rating ?? null,
      fc: score.fc ?? null,
      fs: score.fs ?? null,
      title: music?.title ?? 'Unknown Title',
      detailLevelText,
    };
  }

  private async loadCoverImage(
    musicId: string,
  ): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
    const local = await this.covers.getLocalPathIfExists(musicId);
    if (local) {
      return loadImage(local);
    }

    return null;
  }

  /** Timeout for remote image fetches (ms) */
  private static readonly REMOTE_IMAGE_TIMEOUT_MS = 3_000;

  /** Cache for remote images (avatar, rank icons, etc.) */
  private readonly remoteImageCache = new Map<
    string,
    Awaited<ReturnType<typeof loadImage>> | null
  >();

  /**
   * Load a remote image by URL.
   *
   * We intentionally avoid passing the URL directly to `loadImage()` because
   * its internal HTTP client (Rust/napi) bypasses Node.js DNS resolution,
   * and Docker's embedded DNS returns SERVFAIL for AAAA queries on some CDNs
   * (e.g. maimai.wahlap.com), causing ~5 s hangs per request.
   *
   * Instead we use Node.js `fetch` (which honours our dns.lookup monkey-patch
   * for IPv4-only resolution) to download the image bytes, then decode them
   * with `loadImage(Buffer)`.
   */
  private async loadRemoteImage(
    url: string,
  ): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
    if (this.remoteImageCache.has(url)) {
      return this.remoteImageCache.get(url)!;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        ScoreExportService.REMOTE_IMAGE_TIMEOUT_MS,
      );
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        this.remoteImageCache.set(url, null);
        return null;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const img = await loadImage(buf);
      this.remoteImageCache.set(url, img);
      return img;
    } catch {
      this.remoteImageCache.set(url, null);
      return null;
    }
  }

  private async loadIconImage(
    icon: string,
  ): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
    if (this.iconCache.has(icon)) {
      return this.iconCache.get(icon)!;
    }

    const iconPath = join(
      process.cwd(),
      'assets',
      'icons',
      `music_icon_${icon}.png`,
    );

    try {
      const img = await loadImage(iconPath);
      this.iconCache.set(icon, img);
      return img;
    } catch {
      this.iconCache.set(icon, null);
      return null;
    }
  }
}
