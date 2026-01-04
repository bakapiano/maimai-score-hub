import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MusicEntity } from '../music/music.schema';
import type { MusicDocument } from '../music/music.schema';

type SyncSummary = {
  total: number;
  saved: number;
  skipped: number;
  failed: number;
};

@Injectable()
export class CoverService {
  private readonly logger = new Logger(CoverService.name);
  private readonly baseUrl = 'https://www.diving-fish.com/covers';
  private readonly baseDir = join(process.cwd(), 'covers');

  constructor(
    @InjectModel(MusicEntity.name)
    private readonly musicModel: Model<MusicDocument>,
  ) {}

  private padId(id: string) {
    return id.length < 5 ? id.padStart(5, '0') : id;
  }

  private buildRemoteUrl(id: string) {
    const padded = this.padId(id);
    return `${this.baseUrl}/${padded}.png`;
  }

  private buildLocalPath(id: string) {
    const padded = this.padId(id);
    return join(this.baseDir, `${padded}.png`);
  }

  async getLocalPathIfExists(id: string) {
    const path = this.buildLocalPath(id);
    try {
      await stat(path);
      return path;
    } catch {
      return null;
    }
  }

  private async ensureDir() {
    await mkdir(this.baseDir, { recursive: true });
  }

  async syncAll(): Promise<SyncSummary> {
    const musics = await this.musicModel.find().select({ id: 1 }).lean();
    const summary: SyncSummary = {
      total: musics.length,
      saved: 0,
      skipped: 0,
      failed: 0,
    };

    await this.ensureDir();

    let processed = 0;
    const tasks = musics.map((m) => async () => {
      const id = String(m.id);
      const localPath = this.buildLocalPath(id);
      const exists = await this.getLocalPathIfExists(id);
      if (exists) {
        summary.skipped += 1;
      } else {
        const url = this.buildRemoteUrl(id);
        try {
          const res = await fetch(url);
          if (!res.ok) {
            summary.failed += 1;
            this.logger.warn(
              `Cover fetch failed for ${id}: HTTP ${res.status}`,
            );
          } else {
            const buf = Buffer.from(await res.arrayBuffer());
            await writeFile(localPath, buf);
            summary.saved += 1;
          }
        } catch (e) {
          summary.failed += 1;
          this.logger.error(`Cover fetch error for ${id}: ${e}`);
        }
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
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
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
