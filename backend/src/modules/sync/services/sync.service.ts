import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { MusicEntity } from '../../music/schemas/music.schema';
import type {
  ChartPayload,
  MusicDocument,
} from '../../music/schemas/music.schema';
import { SyncEntity } from '../schemas/sync.schema';
import type { SyncDocument, SyncScore } from '../schemas/sync.schema';
import { getRating, normalizeAchievement } from '../../../common/rating';
import { convertSyncScoresToDivingFishRecords } from '../../../common/prober/diving-fish/converter';
import { uploadRecords as uploadDivingFishRecords } from '../../../common/prober/diving-fish/api';
import { convertSyncScoresToLxnsPayload } from '../../../common/prober/lxns/converter';
import { uploadLxnsScores } from '../../../common/prober/lxns/client';
import { ProberExportMapService } from './prober-export-map.service';
import type { SdgbWorkerMusicEntry } from '@maimai-score-hub/shared';

type JobLike = {
  id: string;
  friendCode: string;
  jobType?: string;
  result?: any;
};

type MusicRow = MusicEntity & {
  charts?: ChartPayload[];
};

type ScoreSnapshot = SyncScore;
type SyncForExport = {
  id: string;
  friendCode: string;
  scores?: SyncScore[];
};
type MusicCache = {
  at: number;
  rows: MusicRow[];
  byId: Map<string, MusicRow>;
  byTitleKey: Map<string, MusicRow>;
  byTitle: Map<string, MusicRow[]>;
};
type VsScorePayload = {
  dxScore?: string | null;
  score?: string | null;
  fs?: string | null;
  fc?: string | null;
};
type VsScoreRow = {
  category: string;
  type: string;
  title: string;
  chartIndex: number;
  payload: VsScorePayload;
};

export type RecentFcFsEvent = {
  time?: unknown;
  songName?: unknown;
  difficulty?: unknown;
  fc?: unknown;
  fs?: unknown;
};

const DIFFICULTY_TO_CHART_INDEX: Record<string, number> = {
  basic: 0,
  advanced: 1,
  expert: 2,
  master: 3,
  remaster: 4,
  utage: 10,
};

// Rank tables for FC / FS — higher index = better. null is below
// everything. Used by mergeScoreKeepBest so re-attempts that didn't
// improve a clear flag don't downgrade the user's PB.
const FC_RANK = ['fc', 'fcp', 'ap', 'app'] as const;
const FS_RANK = ['fs', 'fsp', 'fdx', 'fdxp'] as const;
function rankIdx(table: readonly string[], v: string | null): number {
  if (v === null) {
    return -1;
  }
  const i = table.indexOf(v);
  return i < 0 ? -1 : i;
}
function pickHigher(
  table: readonly string[],
  a: string | null,
  b: string | null,
): string | null {
  return rankIdx(table, b) > rankIdx(table, a) ? b : a;
}
/** Parse a numeric score string. dxScore is plain int, score is "100.3107%". */
function numScore(v: string | null): number {
  if (v === null) {
    return -Infinity;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : -Infinity;
}
function pickHigherNumeric(a: string | null, b: string | null): string | null {
  return numScore(b) > numScore(a) ? b : a;
}

/**
 * Merge two score snapshots for the same (musicId, chartIndex), keeping
 * the better of each per-attempt field. Identity fields (musicId, cid,
 * chartIndex, type, rating, isNew) come from the newer snapshot since
 * those reflect the latest chart metadata.
 */
function mergeScoreKeepBest(
  old: ScoreSnapshot,
  fresh: ScoreSnapshot,
): ScoreSnapshot {
  return {
    ...fresh,
    dxScore: pickHigherNumeric(old.dxScore, fresh.dxScore),
    score: pickHigherNumeric(old.score, fresh.score),
    fc: pickHigher(FC_RANK, old.fc, fresh.fc),
    fs: pickHigher(FS_RANK, old.fs, fresh.fs),
  };
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private musicCache: MusicCache | null = null;

  constructor(
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncDocument>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
    private readonly proberExportMap: ProberExportMapService,
  ) {}

  async createFromJob(job: JobLike) {
    if (job.jobType && job.jobType !== 'update_score') {
      return null;
    }
    if (!job.result) {
      return null;
    }

    const syncId = randomUUID();
    const newScores = await this.mapResultToScores(job.result);
    if (!newScores.length) {
      this.logger.warn(
        `No scores mapped for job ${job.id}; skipping sync write.`,
      );
      return null;
    }

    // Merge with previous sync's scores instead of overwriting wholesale.
    // A job may scrape only a subset of difficulties (default skips
    // BASIC/ADVANCED/宴会 unless the user opts in to "full sync"), so
    // wholesale replacement would cause those untouched difficulties to
    // disappear from /api/me/sync/latest. Key by (musicId, chartIndex);
    // for overlapping charts, take per-field max (achievement, dxScore,
    // fc rank, fs rank) — never let an old high score get clobbered by
    // a fresher lower one (re-attempt that didn't beat the PB).
    const previous = await this.syncModel
      .findOne({ friendCode: job.friendCode })
      .sort({ createdAt: -1 })
      .lean();
    const scores = this.mergeWithPrevious(previous?.scores, newScores);
    const sync = await this.replaceLatestSync({
      id: syncId,
      jobId: job.id,
      friendCode: job.friendCode,
      scores,
    });

    return sync.toObject();
  }

  async createFromRivalMusic(input: {
    friendCode: string;
    sourceId: string;
    music: SdgbWorkerMusicEntry[];
  }) {
    const syncId = randomUUID();
    const newScores = await this.mapRivalMusicToScores(input.music);
    if (!newScores.length) {
      this.logger.warn(
        `No scores mapped for rival source ${input.sourceId}; skipping sync write.`,
      );
      return null;
    }

    const previous = await this.syncModel
      .findOne({ friendCode: input.friendCode })
      .sort({ createdAt: -1 })
      .lean();

    const merged = this.mergeWithPrevious(previous?.scores, newScores);
    const sync = await this.replaceLatestSync({
      id: syncId,
      jobId: input.sourceId,
      friendCode: input.friendCode,
      scores: merged,
    });

    return sync.toObject();
  }

  async mergeRecentEvents(input: {
    friendCode: string;
    sourceId: string;
    events: RecentFcFsEvent[];
  }): Promise<{
    eventCount: number;
    matchedCount: number;
    updatedCount: number;
    syncId: string | null;
  }> {
    const events = input.events;
    const previous = await this.syncModel
      .findOne({ friendCode: input.friendCode })
      .sort({ createdAt: -1 })
      .lean();
    const previousScores: ScoreSnapshot[] = Array.isArray(previous?.scores)
      ? [...previous.scores]
      : [];
    if (!previousScores.length) {
      return {
        eventCount: input.events.length,
        matchedCount: 0,
        updatedCount: 0,
        syncId: null,
      };
    }

    const { byTitle } = await this.getMusicCache();
    let matchedCount = 0;
    let updatedCount = 0;
    for (const event of events) {
      const songName =
        typeof event.songName === 'string' ? event.songName.trim() : '';
      const difficulty =
        typeof event.difficulty === 'string'
          ? event.difficulty.toLowerCase()
          : '';
      const chartIndex = DIFFICULTY_TO_CHART_INDEX[difficulty];
      if (!songName || chartIndex === undefined) {
        continue;
      }

      const candidates = byTitle.get(songName) ?? [];
      const candidateIds = new Set(candidates.map((m) => m.id));
      if (!candidateIds.size) {
        continue;
      }

      const matches = previousScores.filter(
        (score) =>
          score.chartIndex === chartIndex && candidateIds.has(score.musicId),
      );
      if (matches.length !== 1) {
        continue;
      }
      const score = matches[0];

      matchedCount++;
      const nextFc =
        typeof event.fc === 'string'
          ? pickHigher(FC_RANK, score.fc, event.fc)
          : score.fc;
      const nextFs =
        typeof event.fs === 'string'
          ? pickHigher(FS_RANK, score.fs, event.fs)
          : score.fs;
      if (nextFc !== score.fc || nextFs !== score.fs) {
        score.fc = nextFc;
        score.fs = nextFs;
        updatedCount++;
      }
    }

    if (updatedCount === 0) {
      return {
        eventCount: events.length,
        matchedCount,
        updatedCount,
        syncId: previous?.id ?? null,
      };
    }

    const syncId = randomUUID();
    const sync = await this.replaceLatestSync({
      id: syncId,
      jobId: input.sourceId,
      friendCode: input.friendCode,
      scores: previousScores,
    });

    return {
      eventCount: events.length,
      matchedCount,
      updatedCount,
      syncId: (sync.toObject() as SyncEntity).id,
    };
  }

  async getLatestWithScores(friendCode: string) {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .sort({ createdAt: -1 })
      .lean();

    if (!sync) {
      throw new NotFoundException('No sync found');
    }

    const scores = (Array.isArray(sync.scores) ? sync.scores : []).map(
      (score) => ({
        ...score,
        cid:
          score.musicId +
          '_' +
          (score.chartIndex === 10 ? 0 : score.chartIndex),
      }),
    );

    return {
      id: sync.id,
      createdAt: sync.createdAt,
      updatedAt: sync.updatedAt,
      scores,
      autoExportResult: sync.autoExportResult ?? null,
    };
  }

  async updateAutoExportResultBySyncId(
    syncId: string,
    autoExportResult: {
      divingFish?: { status: string; message?: string } | null;
      lxns?: { status: string; message?: string } | null;
    },
  ) {
    await this.syncModel.updateOne(
      { id: syncId },
      { $set: { autoExportResult } },
    );
  }

  async getLatestSyncId(friendCode: string): Promise<string> {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .sort({ createdAt: -1 })
      .select({ id: 1 })
      .lean<{ id: string } | null>();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    return sync.id;
  }

  private mergeWithPrevious(
    previousScores: SyncScore[] | undefined,
    newScores: ScoreSnapshot[],
  ): ScoreSnapshot[] {
    const merged = new Map<string, ScoreSnapshot>();
    if (Array.isArray(previousScores)) {
      for (const s of previousScores) {
        merged.set(`${s.musicId}::${s.chartIndex}`, s);
      }
    }
    for (const s of newScores) {
      const key = `${s.musicId}::${s.chartIndex}`;
      const old = merged.get(key);
      merged.set(key, old ? mergeScoreKeepBest(old, s) : s);
    }
    return [...merged.values()];
  }

  private async replaceLatestSync(input: {
    id: string;
    jobId: string;
    friendCode: string;
    scores: ScoreSnapshot[];
  }) {
    await this.syncModel.deleteMany({ friendCode: input.friendCode });
    return this.syncModel.create(input);
  }

  private async getMusicCache(): Promise<MusicCache> {
    const now = Date.now();
    if (this.musicCache && now - this.musicCache.at < 5 * 60 * 1000) {
      return this.musicCache;
    }

    const rows = (await this.musicModel.find().lean()) as MusicRow[];
    const byId = new Map<string, MusicRow>();
    const byTitleKey = new Map<string, MusicRow>();
    const byTitle = new Map<string, MusicRow[]>();
    for (const m of rows) {
      byId.set(String(m.id), m);
      const categoryKey = m.category ?? '';
      byTitleKey.set(`${categoryKey}::${m.title}::${m.type}`, m);
      const titleRows = byTitle.get(m.title) ?? [];
      titleRows.push(m);
      byTitle.set(m.title, titleRows);
    }

    this.musicCache = { at: now, rows, byId, byTitleKey, byTitle };
    return this.musicCache;
  }

  private async mapResultToScores(result: unknown): Promise<ScoreSnapshot[]> {
    if (!result || typeof result !== 'object') {
      return [];
    }

    const { byTitleKey: musicMap } = await this.getMusicCache();
    const scores: ScoreSnapshot[] = [];
    for (const row of this.iterVsScoreRows(result)) {
      const score = this.mapVsScoreRow(row, musicMap);
      if (score) {
        scores.push(score);
      }
    }

    return scores;
  }

  private *iterVsScoreRows(result: object): Generator<VsScoreRow> {
    const categoryMap = result as Record<
      string,
      Record<string, Record<string, Record<string, VsScorePayload>>>
    >;
    for (const [category, typeMap] of Object.entries(categoryMap)) {
      if (!typeMap || typeof typeMap !== 'object') {
        continue;
      }
      yield* this.iterVsTypeRows(category, typeMap);
    }
  }

  private *iterVsTypeRows(
    category: string,
    typeMap: Record<string, Record<string, Record<string, VsScorePayload>>>,
  ): Generator<VsScoreRow> {
    for (const [type, songs] of Object.entries(typeMap)) {
      if (!songs || typeof songs !== 'object') {
        continue;
      }
      yield* this.iterVsSongRows(category, type, songs);
    }
  }

  private *iterVsSongRows(
    category: string,
    type: string,
    songs: Record<string, Record<string, VsScorePayload>>,
  ): Generator<VsScoreRow> {
    for (const [title, charts] of Object.entries(songs)) {
      if (!charts || typeof charts !== 'object') {
        continue;
      }
      for (const [indexStr, payload] of Object.entries(charts)) {
        const chartIndex = Number(indexStr);
        if (!Number.isNaN(chartIndex)) {
          yield { category, type, title, chartIndex, payload };
        }
      }
    }
  }

  private mapVsScoreRow(
    row: VsScoreRow,
    musicMap: Map<string, MusicRow>,
  ): ScoreSnapshot | null {
    const dxScoreFromVS = row.payload.dxScore ?? null;
    const scoreFromVS = row.payload.score ?? null;
    if (dxScoreFromVS === null && scoreFromVS === null) {
      return null;
    }
    const resolvedTitle = row.title.length === 0 ? '\u3000' : row.title;
    const music = musicMap.get(
      `${row.category || ''}::${resolvedTitle}::${row.type}`,
    );
    if (!music) {
      this.logger.warn(
        `No music found for score: category="${row.category}", type="${row.type}", title="${resolvedTitle}, key="${row.category || ''}::${resolvedTitle}::${row.type}"`,
      );
      return null;
    }
    const chart = this.resolveChartForIndex(music, row.chartIndex);
    if (!chart?.cid) {
      this.logger.warn(
        `No chart found for score: category="${row.category}", type="${row.type}", title="${row.title}", chartIndex=${row.chartIndex}`,
      );
      return null;
    }
    return this.buildScoreSnapshot(
      row,
      music,
      chart,
      dxScoreFromVS,
      scoreFromVS,
    );
  }

  private resolveChartForIndex(
    music: MusicRow,
    chartIndex: number,
  ): ChartPayload | undefined {
    return Array.isArray(music.charts)
      ? (music.charts[chartIndex === 10 ? 0 : chartIndex] as
          ChartPayload | undefined)
      : undefined;
  }

  private buildScoreSnapshot(
    row: VsScoreRow,
    music: MusicRow,
    chart: ChartPayload,
    dxScoreFromVS: string | null,
    scoreFromVS: string | null,
  ): ScoreSnapshot {
    const achievement = normalizeAchievement(scoreFromVS);
    const musicDetailLevel = chart.detailLevel ?? null;
    const rating =
      musicDetailLevel !== null && achievement !== null
        ? getRating(musicDetailLevel, achievement)
        : null;
    return {
      musicId: music.id,
      cid: music.id + '_' + (row.chartIndex === 10 ? 0 : row.chartIndex),
      chartIndex: row.chartIndex,
      type: row.type,
      dxScore: dxScoreFromVS,
      score: scoreFromVS,
      fs: row.payload.fs ?? null,
      fc: row.payload.fc ?? null,
      rating,
      isNew: music.isNew ?? null,
    };
  }

  private async mapRivalMusicToScores(
    rivalMusic: SdgbWorkerMusicEntry[],
  ): Promise<ScoreSnapshot[]> {
    if (!Array.isArray(rivalMusic) || !rivalMusic.length) {
      return [];
    }

    const { byId: musicMap } = await this.getMusicCache();
    const scores: ScoreSnapshot[] = [];

    for (const entry of rivalMusic) {
      const music = musicMap.get(String(entry.musicId));
      if (!music) {
        continue;
      }

      for (const detail of entry.userRivalMusicDetailList ?? []) {
        const chartIndex = detail.level;
        const chart = Array.isArray(music.charts)
          ? (music.charts[chartIndex === 10 ? 0 : chartIndex] as
              ChartPayload | undefined)
          : undefined;
        if (!chart || chart.cid === undefined || chart.cid === null) {
          continue;
        }

        const score = (detail.achievement / 10000).toFixed(4) + '%';
        const achievement = normalizeAchievement(score);
        const musicDetailLevel = chart.detailLevel ?? null;
        const rating =
          musicDetailLevel !== null && achievement !== null
            ? getRating(musicDetailLevel, achievement)
            : null;

        scores.push({
          musicId: music.id,
          cid: music.id + '_' + (chartIndex === 10 ? 0 : chartIndex),
          chartIndex,
          type: music.type ?? '',
          dxScore: String(detail.deluxscoreMax),
          score,
          fs: null,
          fc: null,
          rating,
          isNew: music.isNew ?? null,
        });
      }
    }

    return scores;
  }

  async exportToDivingFish(friendCode: string, importToken: string) {
    const sync = await this.getSyncForExport({ friendCode });
    return this.exportDivingFishSync(sync, importToken);
  }

  async exportSyncToDivingFish(input: {
    friendCode: string;
    syncId: string;
    importToken: string;
  }) {
    const sync = await this.getSyncForExport({
      friendCode: input.friendCode,
      syncId: input.syncId,
    });
    return this.exportDivingFishSync(sync, input.importToken);
  }

  private async exportDivingFishSync(sync: SyncForExport, importToken: string) {
    const scores: SyncScore[] = Array.isArray(sync.scores) ? sync.scores : [];
    if (!scores.length) {
      return { status: 'skipped', reason: 'no scores to export' };
    }

    const exportMap = await this.proberExportMap.getMap();
    const exportableScores = scores.filter((s) =>
      exportMap.toDivingFishId.has(s.musicId),
    );
    if (!exportableScores.length) {
      return {
        status: 'skipped',
        reason: 'no scores supported by diving-fish',
        scores: scores.length,
        exported: 0,
        skipped: scores.length,
      };
    }

    const records = convertSyncScoresToDivingFishRecords(
      exportableScores,
      exportMap.divingFishTitleByDbId,
    );

    try {
      const res = await uploadDivingFishRecords(records, importToken);
      return {
        status: res.status,
        scores: scores.length,
        exported: records.length,
        skipped: scores.length - exportableScores.length,
        response: res.data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      throw new BadRequestException(message);
    }
  }

  async exportToLxns(friendCode: string, importToken: string) {
    const sync = await this.getSyncForExport({ friendCode });
    return this.exportLxnsSync(sync, importToken);
  }

  async exportSyncToLxns(input: {
    friendCode: string;
    syncId: string;
    importToken: string;
  }) {
    const sync = await this.getSyncForExport({
      friendCode: input.friendCode,
      syncId: input.syncId,
    });
    return this.exportLxnsSync(sync, input.importToken);
  }

  private async exportLxnsSync(sync: SyncForExport, importToken: string) {
    const scores: SyncScore[] = Array.isArray(sync.scores) ? sync.scores : [];
    if (!scores.length) {
      return { status: 'skipped', reason: 'no scores to export' };
    }

    const exportMap = await this.proberExportMap.getMap();
    const exportableScores = scores.filter((s) =>
      exportMap.toLxnsId.has(s.musicId),
    );
    if (!exportableScores.length) {
      return {
        status: 'skipped',
        reason: 'no scores supported by lxns',
        scores: scores.length,
        exported: 0,
        skipped: scores.length,
      };
    }

    const { scores: payload } = convertSyncScoresToLxnsPayload(
      exportableScores,
      exportMap.toLxnsId,
    );
    const res = await uploadLxnsScores(payload, importToken);

    return {
      status: res.status,
      scores: scores.length,
      exported: res.exported,
      skipped: scores.length - exportableScores.length,
      response: res.response,
    };
  }

  private async getSyncForExport(input: {
    friendCode: string;
    syncId?: string;
  }): Promise<SyncForExport> {
    const query = input.syncId
      ? { id: input.syncId, friendCode: input.friendCode }
      : { friendCode: input.friendCode };
    let dbQuery = this.syncModel.findOne(query);
    if (!input.syncId) {
      dbQuery = dbQuery.sort({ createdAt: -1 });
    }
    const sync = await dbQuery.lean<SyncForExport | null>();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    return sync;
  }
}
