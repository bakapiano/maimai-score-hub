import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { loadImage } from '@napi-rs/canvas';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { CoverService } from '../../cover/services/cover.service';
import { MusicEntity } from '../../music/schemas/music.schema';
import type {
  ChartPayload,
  MusicDocument,
} from '../../music/schemas/music.schema';
import { SyncEntity } from '../../sync/schemas/sync.schema';
import type { SyncDocument, SyncScore } from '../../sync/schemas/sync.schema';
import { UsersService } from '../../users/services/users.service';
import type { UserNetProfile } from '../../users/user.types';
import { ensureFontsLoaded } from '../rendering/score-export.fonts';
import {
  buildLevelBuckets,
  buildRatingSummary,
  buildVersionBuckets,
} from '../score-export.buckets';
import type {
  ChartEntry,
  CompactCard,
  MusicRow,
  PlatePlan,
  VersionBucket,
} from '../score-export.types';
import {
  renderBest50Image,
  renderLevelScoresImage,
  renderVersionScoresImage,
} from '../rendering/score-export.render';
import { observeFetch } from '../../../common/observability/external-call-recorder';

const LEGACY_VERSION_KEYS = [
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
];

const VERSION_MERGE_MAP: Record<string, string[]> = {
  maimai: ['maimai', 'maimai+'],
};

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

    let current = this.resolveVersionBucket(buckets, versionKey);
    current = this.filterByMinLevel(current, minLevel);
    current = this.filterRemasterForVersion(current, versionKey);
    const profile = await this.loadOptionalProfile(friendCode);

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

  private resolveVersionBucket(
    buckets: VersionBucket[],
    versionKey: string | undefined,
  ): VersionBucket {
    if (versionKey === '__mai__') {
      return this.mergeVersionBuckets(
        '__mai__',
        buckets.filter((b) => LEGACY_VERSION_KEYS.includes(b.versionKey)),
      );
    }
    const mergeVersions = VERSION_MERGE_MAP[versionKey ?? ''];
    if (mergeVersions) {
      return this.mergeVersionBuckets(
        versionKey!,
        buckets.filter((b) => mergeVersions.includes(b.versionKey)),
      );
    }
    return buckets.find((b) => b.versionKey === versionKey) ?? buckets[0];
  }

  private mergeVersionBuckets(
    versionKey: string,
    buckets: VersionBucket[],
  ): VersionBucket {
    const mergedLevelMap = new Map<
      string,
      { items: ChartEntry[]; levelNumeric: number | null }
    >();
    for (const bucket of buckets) {
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
    return {
      versionKey,
      levels: this.sortMergedLevels(mergedLevelMap),
    };
  }

  private sortMergedLevels(
    mergedLevelMap: Map<
      string,
      { items: ChartEntry[]; levelNumeric: number | null }
    >,
  ): VersionBucket['levels'] {
    return Array.from(mergedLevelMap.entries())
      .map(([levelKey, { items, levelNumeric }]) => ({
        levelKey,
        levelNumeric,
        items: items.sort(
          (a, b) => this.detailLevelOf(b) - this.detailLevelOf(a),
        ),
      }))
      .sort(
        (a, b) => (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity),
      );
  }

  private detailLevelOf(entry: ChartEntry): number {
    return typeof entry.chart?.detailLevel === 'number'
      ? entry.chart.detailLevel
      : -Infinity;
  }

  private filterByMinLevel(
    bucket: VersionBucket,
    minLevel: number | undefined,
  ): VersionBucket {
    if (minLevel === undefined || isNaN(minLevel)) {
      return bucket;
    }
    return {
      ...bucket,
      levels: bucket.levels
        .map((level) => ({
          ...level,
          items: level.items.filter((item) =>
            this.matchesMinLevel(item, level.levelNumeric, minLevel),
          ),
        }))
        .filter((level) => level.items.length > 0),
    };
  }

  private matchesMinLevel(
    item: ChartEntry,
    levelNumeric: number | null,
    minLevel: number,
  ): boolean {
    const detailLevel = item.chart?.detailLevel;
    if (typeof detailLevel === 'number') {
      return detailLevel >= minLevel;
    }
    return levelNumeric !== null && levelNumeric >= minLevel;
  }

  private filterRemasterForVersion(
    bucket: VersionBucket,
    versionKey: string | undefined,
  ): VersionBucket {
    if (versionKey === '__mai__') {
      return bucket;
    }
    return {
      ...bucket,
      levels: bucket.levels
        .map((level) => ({
          ...level,
          items: level.items.filter((item) => item.chartIndex !== 4),
        }))
        .filter((level) => level.items.length > 0),
    };
  }

  private async loadOptionalProfile(
    friendCode: string,
  ): Promise<UserNetProfile | null> {
    try {
      const user = await this.users.findByFriendCode(friendCode);
      return user?.profile ?? null;
    } catch {
      return null;
    }
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
    const dxScore = this.parseDxScore(score.dxScore);
    const dxScoreMax = this.getDxScoreMax(chart);
    const detailLevelText =
      typeof chart?.detailLevel === 'number'
        ? chart.detailLevel.toFixed(1)
        : (chart?.detailLevel ?? chart?.level ?? '?');

    return {
      musicId: score.musicId,
      chartIndex: score.chartIndex,
      type: score.type,
      score: score.score ?? null,
      dxScore: score.dxScore ?? null,
      dxScoreMax,
      dxStar:
        dxScore !== null && dxScoreMax !== null && dxScoreMax > 0
          ? this.getDxStar((dxScore / dxScoreMax) * 100)
          : null,
      rating: score.rating ?? null,
      fc: score.fc ?? null,
      fs: score.fs ?? null,
      title: music?.title ?? 'Unknown Title',
      detailLevelText,
    };
  }

  private parseDxScore(value: string | null | undefined): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private getDxScoreMax(chart: ChartPayload | null | undefined): number | null {
    const total = this.getNotesTotal(chart?.notes);
    return total !== null ? total * 3 : null;
  }

  private getNotesTotal(notes: unknown): number | null {
    if (Array.isArray(notes)) {
      return this.sumNumericValues(notes);
    }
    if (!notes || typeof notes !== 'object') {
      return null;
    }

    const record = notes as Record<string, unknown>;
    const total = this.toFiniteNumber(record.total);
    if (total !== null) {
      return total;
    }
    if (record.notes !== undefined) {
      const nested = this.getNotesTotal(record.notes);
      if (nested !== null) {
        return nested;
      }
    }

    return this.sumNumericValues([
      record.tap,
      record.hold,
      record.slide,
      record.touch,
      record.break,
    ]);
  }

  private sumNumericValues(values: unknown[]): number | null {
    let total = 0;
    let found = false;
    for (const value of values) {
      const n = this.toFiniteNumber(value);
      if (n !== null) {
        total += n;
        found = true;
      }
    }
    return found ? total : null;
  }

  private toFiniteNumber(value: unknown): number | null {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;
    return Number.isFinite(n) ? n : null;
  }

  private getDxStar(dxPercent: number): number {
    if (dxPercent <= 85) {
      return 0;
    }
    if (dxPercent <= 90) {
      return 1;
    }
    if (dxPercent <= 93) {
      return 2;
    }
    if (dxPercent <= 95) {
      return 3;
    }
    if (dxPercent <= 97) {
      return 4;
    }
    return 5;
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
      const res = await observeFetch(
        {
          target: 'asset',
          apiGroup: 'score_export',
          method: 'GET',
          urlGroup: classifyImageUrl(url),
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(url, { signal: controller.signal }),
      );
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

function classifyImageUrl(url: string): string {
  if (url.includes('wahlap')) {
    return 'maimai.asset';
  }
  if (url.includes('diving-fish')) {
    return 'diving_fish.asset';
  }
  if (url.includes('lxns')) {
    return 'lxns.asset';
  }
  return 'remote.asset';
}
