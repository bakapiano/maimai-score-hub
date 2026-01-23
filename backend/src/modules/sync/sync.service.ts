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
};

type MusicRow = MusicEntity & {
  charts?: ChartPayload[];
};

type ScoreSnapshot = SyncScore;

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
    if (!job.result) return null;

    const syncId = randomUUID();
    const scores = await this.mapResultToScores(job.result);
    if (!scores.length) {
      this.logger.warn(
        `No scores mapped for job ${job.id}; skipping sync write.`,
      );
      return null;
    }

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
    };
  }

  private async mapResultToScores(result: any): Promise<ScoreSnapshot[]> {
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

            const dxScore = payload?.dxScore ?? null;
            const score = payload?.score ?? null;
            if (dxScore === null && score === null) {
              continue;
            }

            // Fix for 11422, title is single space
            if (resolvedTitle.length === 0) {
              resolvedTitle = ' ';
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
      exported: res.exported,
      response: res.response,
    };
  }
}
