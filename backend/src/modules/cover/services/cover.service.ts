import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import type { Model } from 'mongoose';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

import { MusicEntity } from '../../music/schemas/music.schema';
import type { MusicDocument } from '../../music/schemas/music.schema';
import {
  buildDivingFishDocs,
  buildIdMap,
  buildLxnsDocs,
} from '../../../common/prober/id-map';
import { getLxnsSongListUrl } from '../../../common/prober/lxns/transform';
import type { LxnsApiResponse } from '../../../common/prober/lxns/transform';
import type { DivingFishItem } from '../../../common/prober/diving-fish/transform';
import { observeFetch } from '../../../common/observability/external-call-recorder';

type SyncSummary = {
  total: number;
  saved: number;
  skipped: number;
  failed: number;
};

type LocalBackfillSummary = {
  total: number;
  saved: number;
  skipped: number;
  failed: number;
};

type CoverFormat = 'png' | 'webp';

const DIVING_FISH_MUSIC_URL =
  'https://www.diving-fish.com/api/maimaidxprober/music_data';

@Injectable()
export class CoverService {
  private readonly logger = new Logger(CoverService.name);
  private readonly divingFishCoverBase = 'https://www.diving-fish.com/covers';
  private readonly lxnsCoverBase = 'https://assets.lxns.net/maimai/jacket';
  private readonly baseDir = join(process.cwd(), 'covers');
  private scheduledSyncRunning = false;

  constructor(
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
  ) {}

  private padId(id: string) {
    return id.length < 5 ? id.padStart(5, '0') : id;
  }

  private buildLocalPath(id: string, format: CoverFormat = 'png') {
    const padded = this.padId(id);
    return join(this.baseDir, `${padded}.${format}`);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** diving-fish cover URL: 5-digit zero-padded id */
  private buildDivingFishUrl(divingFishId: string) {
    const padded = this.padId(divingFishId);
    return `${this.divingFishCoverBase}/${padded}.png`;
  }

  /** lxns cover URL: raw numeric song id */
  private buildLxnsUrl(lxnsId: string) {
    return `${this.lxnsCoverBase}/${lxnsId}.png!webp`;
  }

  async getLocalPathIfExists(id: string, format: CoverFormat = 'png') {
    const path = this.buildLocalPath(id, format);
    return (await this.pathExists(path)) ? path : null;
  }

  async getPreferredLocalPath(id: string, preferWebp: boolean) {
    if (preferWebp) {
      const webp = await this.getLocalPathIfExists(id, 'webp');
      if (webp) {
        return { path: webp, format: 'webp' as const };
      }
      const png = await this.getLocalPathIfExists(id, 'png');
      return png ? { path: png, format: 'png' as const } : null;
    }

    const png = await this.getLocalPathIfExists(id, 'png');
    if (png) {
      return { path: png, format: 'png' as const };
    }
    const webp = await this.getLocalPathIfExists(id, 'webp');
    return webp ? { path: webp, format: 'webp' as const } : null;
  }

  async getCoverCount(): Promise<number> {
    try {
      const files = await readdir(this.baseDir);
      return files.filter((f) => f.endsWith('.png')).length;
    } catch {
      return 0;
    }
  }

  private async ensureDir() {
    await mkdir(this.baseDir, { recursive: true });
  }

  private async buildCrossIdMap(): Promise<{
    toDivingFishId: (dbId: string) => string | null;
    toLxnsId: (dbId: string) => string | null;
  }> {
    this.logger.log('Fetching both sources to build ID mapping...');

    const [dfRaw, lxnsRaw] = await Promise.all([
      observeFetch(
        {
          target: 'diving_fish',
          apiGroup: 'catalog',
          method: 'GET',
          urlGroup: 'diving_fish.music_data',
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(DIVING_FISH_MUSIC_URL),
      ).then(async (r) => {
        if (!r.ok) {
          throw new Error(`diving-fish responded ${r.status}`);
        }
        const payload: unknown = await r.json();
        if (!Array.isArray(payload)) {
          throw new Error('diving-fish returned non-array music payload');
        }
        return payload as DivingFishItem[];
      }),
      observeFetch(
        {
          target: 'lxns',
          apiGroup: 'catalog',
          method: 'GET',
          urlGroup: 'lxns.song_list',
          statusCode: 0,
          durationMs: 0,
        },
        () => fetch(getLxnsSongListUrl()),
      ).then(async (r) => {
        if (!r.ok) {
          throw new Error(`lxns responded ${r.status}`);
        }
        return r.json() as Promise<LxnsApiResponse>;
      }),
    ]);

    const dfDocs = buildDivingFishDocs(dfRaw);
    const lxDocs = buildLxnsDocs(lxnsRaw);
    const { dfToLxns } = buildIdMap(dfDocs, lxDocs);

    this.logger.log(
      `ID mapping built: ${dfToLxns.size} diving-fish↔lxns pairs`,
    );

    return {
      toDivingFishId: (dbId) => dbId,
      toLxnsId: (dbId) => dfToLxns.get(dbId) ?? null,
    };
  }

  async syncAll(): Promise<SyncSummary> {
    return this.doSync(false);
  }

  async forceSyncAll(): Promise<SyncSummary> {
    return this.doSync(true);
  }

  @Cron('0 3 * * *', { timeZone: 'Asia/Shanghai' })
  async runScheduledDailySync() {
    if (this.scheduledSyncRunning) {
      this.logger.warn('Skip scheduled cover sync: previous run still active.');
      return;
    }

    this.scheduledSyncRunning = true;
    this.logger.log('Starting scheduled cover sync (daily 03:00 UTC+8).');
    try {
      const summary = await this.syncAll();
      this.logger.log(
        `Scheduled cover sync done: total=${summary.total}, saved=${summary.saved}, skipped=${summary.skipped}, failed=${summary.failed}`,
      );
    } catch (err) {
      this.logger.error(
        `Scheduled cover sync failed: ${(err as Error).message}`,
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      this.scheduledSyncRunning = false;
    }
  }

  async backfillLocalVariants(): Promise<LocalBackfillSummary> {
    await this.ensureDir();

    const files = await readdir(this.baseDir);
    const idSet = new Set<string>();
    for (const file of files) {
      const match = /^(\d+)\.(png|webp)$/i.exec(file);
      if (!match) {
        continue;
      }
      idSet.add(match[1]);
    }

    const ids = Array.from(idSet);
    const summary: LocalBackfillSummary = {
      total: ids.length,
      saved: 0,
      skipped: 0,
      failed: 0,
    };

    let processed = 0;
    const tasks = ids.map((id) => async () => {
      const pngPath = this.buildLocalPath(id, 'png');
      const webpPath = this.buildLocalPath(id, 'webp');
      const [pngExists, webpExists] = await Promise.all([
        this.pathExists(pngPath),
        this.pathExists(webpPath),
      ]);

      if (pngExists && webpExists) {
        summary.skipped += 1;
      } else if (pngExists) {
        const ok = await this.convertLocalVariant(pngPath, webpPath, 'webp');
        if (ok) {
          summary.saved += 1;
        } else {
          summary.failed += 1;
        }
      } else if (webpExists) {
        const ok = await this.convertLocalVariant(webpPath, pngPath, 'png');
        if (ok) {
          summary.saved += 1;
        } else {
          summary.failed += 1;
        }
      } else {
        summary.failed += 1;
      }

      processed += 1;
      if (processed % 100 === 0 || processed === summary.total) {
        this.logger.log(
          `Local cover backfill progress: ${processed}/${summary.total} (saved=${summary.saved}, skipped=${summary.skipped}, failed=${summary.failed})`,
        );
      }
    });

    await runWithConcurrency(tasks, 8);
    return summary;
  }

  private async doSync(force: boolean): Promise<SyncSummary> {
    this.logger.log(`Using diving-fish music data source, force=${force}`);

    const musics = await this.musicModel.find().select({ id: 1 }).lean();
    const summary: SyncSummary = {
      total: musics.length,
      saved: 0,
      skipped: 0,
      failed: 0,
    };

    await this.ensureDir();

    const { toDivingFishId, toLxnsId } = await this.buildCrossIdMap();

    let processed = 0;
    const tasks = musics.map((m) => async () => {
      const dbId = String(m.id);
      const result = await this.ensureCoverVariants(
        dbId,
        force,
        toDivingFishId,
        toLxnsId,
      );

      if (result === 'skipped') {
        summary.skipped += 1;
      } else if (result === 'saved') {
        summary.saved += 1;
      } else {
        summary.failed += 1;
      }

      processed += 1;
      if (processed % 50 === 0 || processed === summary.total) {
        this.logger.log(
          `Cover sync progress: ${processed}/${summary.total} (saved=${summary.saved}, skipped=${summary.skipped}, failed=${summary.failed})`,
        );
      }
    });

    await runWithConcurrency(tasks, 16);

    return summary;
  }

  private async ensureCoverVariants(
    dbId: string,
    force: boolean,
    toDivingFishId: (dbId: string) => string | null,
    toLxnsId: (dbId: string) => string | null,
  ): Promise<'saved' | 'skipped' | 'failed'> {
    const pngPath = this.buildLocalPath(dbId, 'png');
    const webpPath = this.buildLocalPath(dbId, 'webp');

    const [pngExists, webpExists] = await Promise.all([
      this.pathExists(pngPath),
      this.pathExists(webpPath),
    ]);

    if (force) {
      const saved = await this.fetchAndSaveCoverVariants(
        dbId,
        toDivingFishId,
        toLxnsId,
      );
      return saved ? 'saved' : 'failed';
    }

    if (pngExists && webpExists) {
      return 'skipped';
    }

    if (pngExists && !webpExists) {
      const generated = await this.convertLocalVariant(
        pngPath,
        webpPath,
        'webp',
      );
      if (generated) {
        return 'saved';
      }
    }

    if (webpExists && !pngExists) {
      const generated = await this.convertLocalVariant(
        webpPath,
        pngPath,
        'png',
      );
      if (generated) {
        return 'saved';
      }
    }

    const saved = await this.fetchAndSaveCoverVariants(
      dbId,
      toDivingFishId,
      toLxnsId,
    );
    return saved ? 'saved' : 'failed';
  }

  private async convertLocalVariant(
    inputPath: string,
    outputPath: string,
    format: CoverFormat,
  ): Promise<boolean> {
    try {
      const image = sharp(inputPath, { failOn: 'none' });
      if (format === 'webp') {
        await image.webp({ quality: 78 }).toFile(outputPath);
      } else {
        await image.png().toFile(outputPath);
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Failed to convert local cover variant: ${inputPath} -> ${outputPath} (${(err as Error).message})`,
      );
      return false;
    }
  }

  private async saveCoverVariantsFromBuffer(
    dbId: string,
    sourceBuffer: Buffer,
  ): Promise<boolean> {
    const pngPath = this.buildLocalPath(dbId, 'png');
    const webpPath = this.buildLocalPath(dbId, 'webp');

    try {
      const image = sharp(sourceBuffer, { failOn: 'none' });
      await Promise.all([
        image.clone().png().toFile(pngPath),
        image.clone().webp({ quality: 78 }).toFile(webpPath),
      ]);
      return true;
    } catch (err) {
      this.logger.warn(
        `Failed to save cover variants for dbId=${dbId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async fetchAndSaveCoverVariants(
    dbId: string,
    toDivingFishId: (dbId: string) => string | null,
    toLxnsId: (dbId: string) => string | null,
  ): Promise<boolean> {
    const source = await this.fetchCoverSourceBuffer(
      dbId,
      toDivingFishId,
      toLxnsId,
    );

    if (!source) {
      return false;
    }

    return this.saveCoverVariantsFromBuffer(dbId, source);
  }

  private async fetchCoverSourceBuffer(
    dbId: string,
    toDivingFishId: (dbId: string) => string | null,
    toLxnsId: (dbId: string) => string | null,
  ): Promise<Buffer | null> {
    const dfId = toDivingFishId(dbId);
    if (dfId) {
      const url = this.buildDivingFishUrl(dfId);
      try {
        const res = await observeFetch(
          {
            target: 'diving_fish',
            apiGroup: 'cover',
            method: 'GET',
            urlGroup: 'diving_fish.cover',
            statusCode: 0,
            durationMs: 0,
            attrs: { dbId },
          },
          () => fetch(url),
        );
        if (res.ok) {
          return Buffer.from(await res.arrayBuffer());
        }
      } catch {
        // fall through
      }
    }

    const lxId = toLxnsId(dbId);
    if (lxId) {
      const url = this.buildLxnsUrl(lxId);
      try {
        const res = await observeFetch(
          {
            target: 'lxns',
            apiGroup: 'cover',
            method: 'GET',
            urlGroup: 'lxns.cover',
            statusCode: 0,
            durationMs: 0,
            attrs: { dbId },
          },
          () => fetch(url),
        );
        const cacheControl = res.headers.get('cache-control');
        if (res.ok && cacheControl !== 'no-cache') {
          return Buffer.from(await res.arrayBuffer());
        }
      } catch {
        // fall through
      }
    }

    this.logger.warn(
      `Cover not found for dbId=${dbId} (dfId=${dfId ?? '?'}, lxId=${lxId ?? '?'})`,
    );
    return null;
  }
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  const workers = new Array(Math.min(limit, tasks.length))
    .fill(null)
    .map(async () => {
      while (next < tasks.length) {
        const idx = next++;
        results[idx] = await tasks[idx]();
      }
    });

  await Promise.all(workers);
  return results;
}
