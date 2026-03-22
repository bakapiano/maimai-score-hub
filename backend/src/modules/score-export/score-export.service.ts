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
import type { CompactCard, MusicRow } from './score-export.types';
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

    return renderLevelScoresImage(
      current,
      levelKey ?? current.levelKey,
      (musicId) => this.loadCoverImage(musicId),
      (icon) => this.loadIconImage(icon),
    );
  }

  async generateVersionScoresImage(
    friendCode: string,
    versionKey?: string,
    minLevel?: number,
  ): Promise<Buffer> {
    ensureFontsLoaded();
    const { scores, musics } = await this.loadData(friendCode, true);
    const filteredMusics = musics.filter((m) => m.type !== 'utage');
    const filteredScores = scores.filter((s) => s.type !== 'utage');
    const buckets = buildVersionBuckets(filteredMusics, filteredScores);
    if (!buckets.length) {
      throw new NotFoundException('No version data');
    }

    let current =
      buckets.find((b) => b.versionKey === versionKey) ?? buckets[0];

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

    return renderVersionScoresImage(
      current,
      versionKey ?? current.versionKey,
      (musicId) => this.loadCoverImage(musicId),
      (icon) => this.loadIconImage(icon),
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

  private async loadRemoteImage(
    url: string,
  ): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
    try {
      return await loadImage(url);
    } catch {
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
