import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { MusicEntity } from '../music/music.schema';
import type { ChartPayload, MusicDocument } from '../music/music.schema';
import { SyncEntity } from './sync.schema';
import type { SyncDocument, SyncScore } from './sync.schema';
import { getRating, normalizeAchievement } from '../../common/rating';
import { convertSyncScoresToDivingFishRecords } from '../../common/prober/diving-fish/converter';
import { uploadRecords as uploadDivingFishRecords } from '../../common/prober/diving-fish/api';
import { convertSyncScoresToLxnsPayload } from '../../common/prober/lxns/converter';
import { uploadLxnsScores } from '../../common/prober/lxns/client';

type JobLike = {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  result?: any;
  cabinetScoreMap?: Record<string, { achievement: number; dxScore: number }> | null;
};

type MusicRow = MusicEntity & {
  charts?: ChartPayload[];
};

type ScoreSnapshot = SyncScore;

// Rank tables for FC / FS — higher index = better. null is below
// everything. Used by mergeScoreKeepBest so re-attempts that didn't
// improve a clear flag don't downgrade the user's PB.
const FC_RANK = ['fc', 'fcp', 'ap', 'app'] as const;
const FS_RANK = ['fs', 'fsp', 'fdx', 'fdxp'] as const;
function rankIdx(table: readonly string[], v: string | null): number {
  if (v == null) return -1;
  const i = table.indexOf(v);
  return i < 0 ? -1 : i;
}
function pickHigher(table: readonly string[], a: string | null, b: string | null): string | null {
  return rankIdx(table, b) > rankIdx(table, a) ? b : a;
}
/** Parse a numeric score string. dxScore is plain int, score is "100.3107%". */
function numScore(v: string | null): number {
  if (v == null) return -Infinity;
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

  constructor(
    @InjectModel(SyncEntity.name)
    private readonly syncModel: Model<SyncDocument>,
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
  ) {}

  async createFromJob(job: JobLike) {
    if (job.skipUpdateScore) return null;
    if (!job.result && !job.cabinetScoreMap) return null;

    const syncId = randomUUID();
    const newScores = await this.mapResultToScores(
      job.result ?? {},
      job.cabinetScoreMap ?? null,
    );
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
    // disappear from /api/sync/latest. Key by (musicId, chartIndex);
    // for overlapping charts, take per-field max (achievement, dxScore,
    // fc rank, fs rank) — never let an old high score get clobbered by
    // a fresher lower one (re-attempt that didn't beat the PB).
    const previous = await this.syncModel
      .findOne({ friendCode: job.friendCode })
      .sort({ createdAt: -1 })
      .lean();
    const merged = new Map<string, ScoreSnapshot>();
    if (previous && Array.isArray(previous.scores)) {
      for (const s of previous.scores as ScoreSnapshot[]) {
        merged.set(`${s.musicId}::${s.chartIndex}`, s);
      }
    }
    for (const s of newScores) {
      const key = `${s.musicId}::${s.chartIndex}`;
      const old = merged.get(key);
      merged.set(key, old ? mergeScoreKeepBest(old, s) : s);
    }
    const scores = [...merged.values()];

    // Delete previous syncs for this friendCode (keep only the latest)
    await this.syncModel.deleteMany({ friendCode: job.friendCode });

    const sync = await this.syncModel.create({
      id: syncId,
      jobId: job.id,
      friendCode: job.friendCode,
      scores,
    });

    return sync.toObject();
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

  async updateAutoExportResult(
    jobId: string,
    autoExportResult: {
      divingFish?: { status: string; message?: string } | null;
      lxns?: { status: string; message?: string } | null;
    },
  ) {
    await this.syncModel.updateOne({ jobId }, { $set: { autoExportResult } });
  }

  private async mapResultToScores(
    result: any,
    cabinetScoreMap?: Record<string, { achievement: number; dxScore: number }> | null,
  ): Promise<ScoreSnapshot[]> {
    if (!result || typeof result !== 'object') return [];

    const musics = (await this.musicModel.find().lean()) as MusicRow[];
    const musicMap = new Map<string, MusicRow>();
    for (const m of musics) {
      const categoryKey = m.category ?? '';
      musicMap.set(`${categoryKey}::${m.title}::${m.type}`, m);
    }

    const scores: ScoreSnapshot[] = [];

    for (const [category, typeMap] of Object.entries(
      result as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >,
    )) {
      if (!typeMap || typeof typeMap !== 'object') continue;

      for (const [type, songs] of Object.entries(
        typeMap as Record<string, Record<string, Record<string, unknown>>>,
      )) {
        if (!songs || typeof songs !== 'object') continue;

        for (const [title, charts] of Object.entries(
          songs as Record<string, Record<string, unknown>>,
        )) {
          if (!charts || typeof charts !== 'object') continue;
          let resolvedTitle = title;

          for (const [indexStr, payload] of Object.entries(
            charts as Record<
              string,
              {
                dxScore?: string | null;
                score?: string | null;
                fs?: string | null;
                fc?: string | null;
              }
            >,
          )) {
            const chartIndex = Number(indexStr);
            if (Number.isNaN(chartIndex)) continue;

            const dxScoreFromVS = payload?.dxScore ?? null;
            const scoreFromVS = payload?.score ?? null;
            // Skip charts that have absolutely no per-attempt data, but
            // only when we don't have cabinet fallback. (When skipDxScore
            // mode is on, payload.dxScore is null but the chart is still
            // worth keeping because cabinet has the dxScore + we just
            // need the fc/fs from VS.)
            if (dxScoreFromVS === null && scoreFromVS === null && !cabinetScoreMap) {
              continue;
            }

            // Fix for 11422, title is single full-width space
            if (resolvedTitle.length === 0) {
              resolvedTitle = '\u3000';
            }

            const music = musicMap.get(
              `${category || ''}::${resolvedTitle}::${type}`,
            );
            if (!music) {
              this.logger.warn(
                `No music found for score: category="${category}", type="${type}", title="${resolvedTitle}, key="${category || ''}::${resolvedTitle}::${type}"`,
              );
              continue;
            }

            const chart = Array.isArray(music.charts)
              ? (music.charts[chartIndex === 10 ? 0 : chartIndex] as
                  | ChartPayload
                  | undefined)
              : undefined;
            if (!chart || chart.cid === undefined || chart.cid === null) {
              this.logger.warn(
                `No chart found for score: category="${category}", type="${type}", title="${title}", chartIndex=${chartIndex}`,
              );
              continue;
            }

            // Cabinet data takes precedence over friend-VS for
            // achievement + dxScore (cabinet is authoritative; VS may
            // be missing dxScore entirely if worker ran in
            // skipDxScoreFetch mode).
            const cabinetKey = `${music.id}_${chartIndex}`;
            const cabinetEntry = cabinetScoreMap?.[cabinetKey];
            const dxScore = cabinetEntry
              ? String(cabinetEntry.dxScore)
              : dxScoreFromVS;
            const score = cabinetEntry
              ? // cabinet achievement is int * 10000, e.g. 1003107 → "100.3107%"
                (cabinetEntry.achievement / 10000).toFixed(4) + '%'
              : scoreFromVS;

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
              type,
              dxScore,
              score,
              fs: payload?.fs ?? null,
              fc: payload?.fc ?? null,
              rating,
              isNew: music.isNew ?? null,
            });
          }
        }
      }
    }

    // For (musicId, chartIndex) pairs that exist in cabinetScoreMap but
    // never appeared in the friend-VS result (because worker's
    // diffsToScrape skipped that diff entirely), synthesize a score-only
    // ScoreSnapshot so the cabinet data still flows into sync. fc/fs
    // stay null; the upstream merge step (mergeScoreKeepBest) keeps any
    // previous fc/fs from the prior sync.
    if (cabinetScoreMap) {
      const seen = new Set(
        scores.map((s) => `${s.musicId}_${s.chartIndex}`),
      );
      for (const [key, entry] of Object.entries(cabinetScoreMap)) {
        if (seen.has(key)) continue;
        const lastUnderscore = key.lastIndexOf('_');
        if (lastUnderscore < 0) continue;
        const musicId = key.slice(0, lastUnderscore);
        const chartIndex = Number(key.slice(lastUnderscore + 1));
        if (!Number.isFinite(chartIndex)) continue;

        const music = musics.find((m) => m.id === musicId);
        if (!music) continue;
        const chart = Array.isArray(music.charts)
          ? (music.charts[chartIndex === 10 ? 0 : chartIndex] as
              | ChartPayload
              | undefined)
          : undefined;
        if (!chart) continue;
        const score = (entry.achievement / 10000).toFixed(4) + '%';
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
          dxScore: String(entry.dxScore),
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
    const sync = await this.syncModel
      .findOne({ friendCode })
      .sort({ createdAt: -1 })
      .lean();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    const scores: SyncScore[] = Array.isArray(sync.scores) ? sync.scores : [];
    if (!scores.length) {
      return { status: 'skipped', reason: 'no scores to export' };
    }

    const musics = (await this.musicModel
      .find()
      .select({ id: 1, title: 1 })
      .lean()) as Array<{ id: string; title: string }>;
    const titleMap = new Map<string, string>();
    for (const music of musics) {
      if (music?.id && music?.title) {
        titleMap.set(music.id, music.title);
      }
    }

    const records = convertSyncScoresToDivingFishRecords(scores, titleMap);

    try {
      const res = await uploadDivingFishRecords(records, importToken);
      return {
        status: res.status,
        scores: scores.length,
        exported: records.length,
        response: res.data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      throw new BadRequestException(message);
    }
  }

  async exportToLxns(friendCode: string, importToken: string) {
    const sync = await this.syncModel
      .findOne({ friendCode })
      .sort({ createdAt: -1 })
      .lean();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }

    const scores: SyncScore[] = Array.isArray(sync.scores) ? sync.scores : [];
    if (!scores.length) {
      return { status: 'skipped', reason: 'no scores to export' };
    }

    const { scores: payload } = convertSyncScoresToLxnsPayload(scores);
    const res = await uploadLxnsScores(payload, importToken);

    return {
      status: res.status,
      scores: scores.length,
      exported: res.exported,
      response: res.response,
    };
  }
}
