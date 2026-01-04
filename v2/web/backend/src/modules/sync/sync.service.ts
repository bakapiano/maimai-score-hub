import {
  BadRequestException,
  ForbiddenException,
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

type ScoreSnapshot = {
  musicId: string;
  cid: number;
  chartIndex: number;
  category: string | null;
  type: string;
  title: string;
  dxScore: string | null;
  score: string | null;
  fs: string | null;
  fc: string | null;
  rating: number | null;
  musicDetailLevel: number | null;
  isNew: boolean | null;
};

const DIVING_FISH_ENDPOINT =
  'https://www.diving-fish.com/api/maimaidxprober/player/update_records';

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

    const sync = await this.syncModel.create({
      id: syncId,
      jobId: job.id,
      friendCode: job.friendCode,
      scores,
    });

    return sync.toObject();
  }

  async listByFriendCode(friendCode: string) {
    const syncs = await this.syncModel
      .find({ friendCode })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    if (!syncs.length) return [];

    return syncs.map((s) => ({
      ...s,
      scoreCount: Array.isArray(s.scores) ? s.scores.length : 0,
      scores: [],
    }));
  }

  async getWithScores(id: string, friendCode: string) {
    const sync = await this.syncModel.findOne({ id }).lean();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    if (sync.friendCode !== friendCode) {
      throw new ForbiddenException('Cannot access this sync');
    }

    const scores = Array.isArray(sync.scores) ? sync.scores : [];
    scores.sort((a: any, b: any) => {
      if (a.musicId !== b.musicId) return a.musicId.localeCompare(b.musicId);
      if (a.cid !== b.cid) return a.cid - b.cid;
      return a.chartIndex - b.chartIndex;
    });

    return { ...sync, scores };
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

    for (const [category, typeMap] of Object.entries(result)) {
      if (!typeMap || typeof typeMap !== 'object') continue;

      for (const [type, songs] of Object.entries(
        typeMap as Record<string, any>,
      )) {
        if (!songs || typeof songs !== 'object') continue;

        for (let [title, charts] of Object.entries(
          songs as Record<string, any>,
        )) {
          if (!charts || typeof charts !== 'object') continue;

          for (const [indexStr, payload] of Object.entries(
            charts as Record<string, any>,
          )) {
            const chartIndex = Number(indexStr);
            if (Number.isNaN(chartIndex)) continue;

            const dxScore = payload?.dxScore ?? null;
            const score = payload?.score ?? null;
            if (dxScore === null && score === null) {
              continue;
            }

            // Fix for 11422, title is single space
            if (title.length === 0) {
              title = ' ';
            }

            const music = musicMap.get(`${category || ''}::${title}::${type}`);
            if (!music) {
              this.logger.warn(
                `No music found for score: category="${category}", type="${type}", title="${title}, key="${category || ''}::${title}::${type}"`,
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
              cid: chart.cid,
              chartIndex,
              category: category || null,
              type,
              title,
              dxScore,
              score,
              fs: payload?.fs ?? null,
              fc: payload?.fc ?? null,
              rating,
              musicDetailLevel,
              isNew: music.isNew ?? null,
            });
          }
        }
      }
    }

    return scores;
  }

  async exportToDivingFish(
    id: string,
    friendCode: string,
    importToken: string,
  ) {
    const sync = await this.syncModel.findOne({ id }).lean();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    if (sync.friendCode !== friendCode) {
      throw new ForbiddenException('Cannot access this sync');
    }

    const scores: SyncScore[] = Array.isArray(sync.scores)
      ? (sync.scores as SyncScore[])
      : [];
    if (!scores.length) {
      return { status: 'skipped', reason: 'no scores to export' };
    }

    const records = convertSyncScoresToDivingFishRecords(scores);
    const res = await fetch(DIVING_FISH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Import-Token': importToken,
      },
      body: JSON.stringify(records),
    });

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      throw new BadRequestException(
        `Diving-fish responded ${res.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    return {
      status: res.status,
      exported: records.length,
      response: data,
    };
  }

  async exportToLxns(id: string, friendCode: string, importToken: string) {
    const sync = await this.syncModel.findOne({ id }).lean();
    if (!sync) {
      throw new NotFoundException('Sync not found');
    }
    if (sync.friendCode !== friendCode) {
      throw new ForbiddenException('Cannot access this sync');
    }

    const scores: SyncScore[] = Array.isArray(sync.scores)
      ? (sync.scores as SyncScore[])
      : [];
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
