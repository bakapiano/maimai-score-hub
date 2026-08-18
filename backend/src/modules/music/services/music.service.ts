import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { ScoreFetchTarget } from '@maimai-score-hub/shared';

import { MusicEntity } from '../schemas/music.schema';
import {
  getDivingFishSourceUrl,
  convertDivingFishItemToDocument,
  type DivingFishItem,
} from '../../../common/prober/diving-fish/transform';
import { observeFetch } from '../../../common/observability/external-call-recorder';

const MUSIC_DATA_SOURCE = 'diving-fish';
const CATEGORY_GENRE: Record<string, number> = {
  '流行&动漫': 101,
  'niconico＆VOCALOID™': 102,
  东方Project: 103,
  其他游戏: 104,
  舞萌: 105,
  '音击/中二节奏': 106,
};
const LEVEL_PARAMETER = new Map(
  [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '7+',
    '8',
    '8+',
    '9',
    '9+',
    '10',
    '10+',
    '11',
    '11+',
    '12',
    '12+',
    '13',
    '13+',
    '14',
    '14+',
    '15',
  ].map((level, index) => [level, index + 1] as const),
);

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);

  constructor(
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicEntity>,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}

  private async fetchJson(
    url: string,
    signal?: AbortSignal,
  ): Promise<ResponseLike> {
    signal?.throwIfAborted();
    if (typeof fetch === 'function') {
      return observeFetch(
        {
          target: 'diving_fish',
          apiGroup: 'catalog',
          method: 'GET',
          urlGroup: 'diving_fish.music_data',
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(url, { signal }),
      );
    }

    // Fallback for environments without global fetch (Node <18)
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<ResponseLike>((resolve, reject) => {
      const req = client(parsed, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: unknown) => {
          chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
        });
        res.on('end', () => {
          signal?.removeEventListener('abort', abortRequest);
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok:
              res.statusCode !== undefined &&
              res.statusCode >= 200 &&
              res.statusCode < 300,
            status: res.statusCode ?? 0,
            json: () => Promise.resolve(JSON.parse(body) as unknown),
          });
        });
      });
      const abortRequest = () => {
        req.destroy(this.abortError(signal));
      };
      if (signal?.aborted) {
        abortRequest();
      } else {
        signal?.addEventListener('abort', abortRequest, { once: true });
      }
      req.on('error', (error) => {
        signal?.removeEventListener('abort', abortRequest);
        reject(error);
      });
      req.end();
    });
  }

  async findAll() {
    const cacheKey = 'music:all';
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    this.logger.log('Fetching all music data from database...');
    const result = await this.musicModel.find().sort({ id: 1 }).lean();
    this.logger.log(`Fetched ${result.length} music records.`);
    await this.cache.set(cacheKey, result, 1000 * 60 * 60);
    return result;
  }

  async resolveScoreFetchTargets(musicIds: string[]): Promise<{
    targets: ScoreFetchTarget[];
    missing: string[];
  }> {
    const requested = [...new Set(musicIds)];
    const requestedSet = new Set(requested);
    if (!requested.length) {
      return { targets: [], missing: [] };
    }
    const rows = await this.musicModel
      .find({ 'charts.cid': { $in: requested } })
      .select('id title type category charts')
      .lean<MusicEntity[]>();
    const resolved = new Map<string, ScoreFetchTarget>();
    for (const music of rows) {
      if (!Array.isArray(music.charts)) {
        continue;
      }
      music.charts.forEach((chart, chartIndex) => {
        const musicId = chart?.cid;
        if (!musicId || !requestedSet.has(musicId)) {
          return;
        }
        const utage = music.type === 'utage';
        resolved.set(musicId, {
          musicId,
          title: music.title,
          type: utage ? 'utage' : music.type === 'dx' ? 'dx' : 'standard',
          category: music.category ?? '',
          diff: utage ? 10 : chartIndex,
          genre: utage ? 99 : (CATEGORY_GENRE[music.category ?? ''] ?? null),
          level: utage
            ? null
            : (LEVEL_PARAMETER.get(chart.level ?? '') ?? null),
        });
      });
    }
    return {
      targets: requested.flatMap((musicId) => {
        const target = resolved.get(musicId);
        return target ? [target] : [];
      }),
      missing: requested.filter((musicId) => !resolved.has(musicId)),
    };
  }

  async syncMusicData(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const sourceUrl = getDivingFishSourceUrl(this.configService);
    this.logger.log(
      `Syncing music data from ${MUSIC_DATA_SOURCE} (${sourceUrl}) ...`,
    );
    return this.syncFromDivingFish(sourceUrl, signal);
  }

  private async syncFromDivingFish(sourceUrl: string, signal?: AbortSignal) {
    let items: DivingFishItem[];

    try {
      const response = await this.fetchJson(sourceUrl, signal);
      if (!response.ok) {
        throw new Error(`Remote responded with status ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error('Unexpected payload structure (not an array)');
      }
      items = payload as DivingFishItem[];
    } catch (error) {
      this.logger.error(
        'Failed to fetch music data from diving-fish',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('Fetch music data failed');
    }

    if (!items.length) {
      this.logger.warn('Music data list is empty; skipping write');
      return {
        matchedCount: 0,
        upsertedCount: 0,
        modifiedCount: 0,
        total: 0,
      };
    }

    const now = new Date();
    const documents = items.map((item) =>
      convertDivingFishItemToDocument(item, now),
    );

    signal?.throwIfAborted();
    return this.persistDocuments(documents, items.length, signal);
  }

  private async persistDocuments(
    documents: Array<ReturnType<typeof convertDivingFishItemToDocument>>,
    total: number,
    signal?: AbortSignal,
  ) {
    try {
      const result = await this.musicModel.bulkWrite(
        documents.map((document) => ({
          updateOne: {
            filter: { id: document.id },
            update: { $set: document },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      signal?.throwIfAborted();
      const stale = await this.musicModel.deleteMany({
        id: { $nin: documents.map((document) => document.id) },
      });
      const summary = {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
        removedCount: stale.deletedCount,
        total,
      };
      this.logger.log(
        `Music data sync finished: total=${summary.total}, upserted=${summary.upsertedCount}, modified=${summary.modifiedCount}, removed=${summary.removedCount}.`,
      );
      await this.cache.del('music:all');
      return summary;
    } catch (error) {
      this.logger.error(
        'Failed to persist music data',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('Persist music data failed');
    }
  }

  private abortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
      ? signal.reason
      : new Error('Music sync aborted');
  }
}

interface ResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
