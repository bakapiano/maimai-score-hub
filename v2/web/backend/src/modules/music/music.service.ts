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

import type { MusicDocument } from './music.schema';
import { MusicEntity } from './music.schema';
import {
  getDivingFishSourceUrl,
  convertDivingFishItemToDocument,
} from '../../common/prober/diving-fish/transform';

@Injectable()
export class MusicService implements OnModuleInit {
  private readonly logger = new Logger(MusicService.name);
  private readonly sourceUrl: string;

  constructor(
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {
    this.sourceUrl = getDivingFishSourceUrl(this.configService);
  }

  private async fetchJson(url: string) {
    if (typeof fetch === 'function') {
      return fetch(url);
    }

    // Fallback for environments without global fetch (Node <18)
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<ResponseLike>((resolve, reject) => {
      const req = client(parsed, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok:
              res.statusCode !== undefined &&
              res.statusCode >= 200 &&
              res.statusCode < 300,
            status: res.statusCode ?? 0,
            json: async () => JSON.parse(body),
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
  async onModuleInit() {
    const cronExpression =
      this.configService.get<string>('MUSIC_SYNC_CRON') ??
      CronExpression.EVERY_6_HOURS;
    this.registerCron(cronExpression);
    // try {
    //   await this.syncMusicData();
    // } catch (error) {
    //   this.logger.error(
    //     'Initial music data sync failed',
    //     error instanceof Error ? error.stack : String(error),
    //   );
    // }
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
    // const cacheKey = 'music:all';
    // const cached = await this.cache.get(cacheKey);
    // if (cached) {
    //   this.logger.log('Music list served from cache');
    //   return cached;
    // }

    this.logger.log('Fetching all music data from database...');
    const result = await this.musicModel.find().sort({ id: 1 }).lean();
    this.logger.log(`Fetched ${result.length} music records.`);
    // await this.cache.set(cacheKey, result, 1000 * 60 * 60); // 1 hour
    return result;
  }

  async syncMusicData() {
    this.logger.log(`Syncing music data from ${this.sourceUrl} ...`);
    let items: any[];

    try {
      const response = await this.fetchJson(this.sourceUrl);
      if (!response.ok) {
        throw new Error(`Remote responded with status ${response.status}`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error('Unexpected payload structure (not an array)');
      }
      items = payload;
    } catch (error) {
      this.logger.error(
        'Failed to fetch music data',
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

    console.log(documents[0]);

    try {
      await this.musicModel.deleteMany({});
      const result = await this.musicModel.insertMany(documents, {
        ordered: false,
      });
      const summary = {
        upsertedCount: result.length,
        total: items.length,
      };
      this.logger.log(
        `Music data sync finished: inserted ${summary.upsertedCount} items (full overwrite).`,
      );
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
  json: () => Promise<any>;
}
