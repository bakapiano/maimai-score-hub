import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { CronJob } from 'cron';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

import type { MusicDocument } from '../schemas/music.schema';
import { MusicEntity } from '../schemas/music.schema';
import {
  getDivingFishSourceUrl,
  convertDivingFishItemToDocument,
  type DivingFishItem,
} from '../../../common/prober/diving-fish/transform';
import { observeFetch } from '../../../common/observability/external-call-recorder';

const MUSIC_DATA_SOURCE = 'diving-fish';

@Injectable()
export class MusicService implements OnModuleInit {
  private readonly logger = new Logger(MusicService.name);

  constructor(
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}

  private async fetchJson(url: string): Promise<ResponseLike> {
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
        () => fetch(url),
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
      req.on('error', reject);
      req.end();
    });
  }

  onModuleInit() {
    const cronExpression =
      this.configService.get<string>('MUSIC_SYNC_CRON') ??
      CronExpression.EVERY_6_HOURS;
    this.registerCron(cronExpression);
  }

  private registerCron(expression: string) {
    try {
      const job = new CronJob(expression, () => {
        void this.syncMusicData();
      });

      this.schedulerRegistry.addCronJob('music-data-sync', job);
      job.start();
      this.logger.log(`Music data sync scheduled with cron: ${expression}`);
    } catch (error) {
      this.logger.error(
        `Failed to register cron job with expression "${expression}"`,
        error instanceof Error ? error.stack : String(error),
      );
    }
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

  async syncMusicData() {
    const sourceUrl = getDivingFishSourceUrl(this.configService);
    this.logger.log(
      `Syncing music data from ${MUSIC_DATA_SOURCE} (${sourceUrl}) ...`,
    );
    return this.syncFromDivingFish(sourceUrl);
  }

  private async syncFromDivingFish(sourceUrl: string) {
    let items: DivingFishItem[];

    try {
      const response = await this.fetchJson(sourceUrl);
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

    return this.persistDocuments(documents, items.length);
  }

  private async persistDocuments(
    documents: Array<ReturnType<typeof convertDivingFishItemToDocument>>,
    total: number,
  ) {
    try {
      await this.musicModel.deleteMany({});
      const result = await this.musicModel.insertMany(documents, {
        ordered: false,
      });
      const summary = {
        upsertedCount: result.length,
        total,
      };
      this.logger.log(
        `Music data sync finished: inserted ${summary.upsertedCount} items (full overwrite).`,
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
}

interface ResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
