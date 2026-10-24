import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ByteLru } from './byte-lru';
import { statsAssetUrl, type PublicStatsProfile } from './stats-card.profile';

const INPUT_LIMIT = 1024 * 1024;
export type CardAssets = {
  avatar: Buffer | null;
  course: Buffer | null;
  rank: Buffer | null;
  star?: Buffer | null;
  signature: string;
};

@Injectable()
export class StatsCardAssets {
  private readonly cache = new ByteLru<Buffer>(
    8 * 1024 * 1024,
    256,
    24 * 60 * 60_000,
  );
  private readonly failures = new ByteLru<true>(4096, 256, 30_000);
  private readonly pending = new Map<string, Promise<Buffer | null>>();

  async prepare(profile: PublicStatsProfile): Promise<CardAssets> {
    const [avatar, course, rank, star] = await Promise.all([
      this.load(profile.avatarUrl, 216, 216),
      this.load(profile.courseRankUrl, 192, 72),
      this.load(profile.classRankUrl, 144, 72),
      this.load(
        profile.awakeningCount === null
          ? null
          : '/maimai-mobile/img/icon_star.png',
        60,
        60,
      ),
    ]);
    const digest = createHash('sha256');
    for (const image of [avatar, course, rank, star]) {
      digest.update(String(image?.length ?? 0) + ':');
      if (image) {
        digest.update(image);
      }
    }
    return { avatar, course, rank, star, signature: digest.digest('hex') };
  }

  private async load(
    url: string | null,
    width: number,
    height: number,
  ): Promise<Buffer | null> {
    const safeUrl = statsAssetUrl(url);
    if (!safeUrl) {
      return null;
    }
    const key = safeUrl + ':' + width + ':' + height;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    if (this.failures.get(key)) {
      return null;
    }
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    // Asset fetches are separately bounded, including private previews.
    if (this.pending.size >= 12) {
      return null;
    }
    const work = this.loadSources(safeUrl, width, height)
      .then((image) => {
        if (image) {
          this.cache.set(key, image, image.length);
        } else {
          this.failures.set(key, true, 16);
        }
        return image;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, work);
    return work;
  }

  private async fetchImage(
    url: string,
    width: number,
    height: number,
  ): Promise<Buffer | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
        headers: { Accept: 'image/png,image/jpeg' },
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return null;
      }
      if (Number(response.headers.get('content-length')) > INPUT_LIMIT) {
        await response.body.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          size += result.value.byteLength;
          if (size > INPUT_LIMIT) {
            await reader.cancel();
            return null;
          }
          chunks.push(Buffer.from(result.value));
        }
      } finally {
        reader.releaseLock();
      }
      const input = Buffer.concat(chunks);
      return await this.normalize(input, width, height);
    } catch {
      return null;
    }
  }

  private async loadSources(
    url: string,
    width: number,
    height: number,
  ): Promise<Buffer | null> {
    // Exact public asset path only; no guessed rank or replacement illustration.
    const relative = new URL(url).pathname.slice('/maimai-mobile/img/'.length);
    const local = join(
      process.cwd(),
      'assets',
      'maimai-mobile',
      'img',
      relative,
    );
    try {
      if ((await stat(local)).size <= INPUT_LIMIT) {
        const image = await this.normalize(
          await readFile(local),
          width,
          height,
        );
        if (image) {
          return image;
        }
      }
    } catch {
      /* Missing local asset: use the online originals. */
    }
    return (
      (await this.fetchImage(url, width, height)) ??
      (await this.fetchImage(
        'https://maiscorehub.bakapiano.com' + new URL(url).pathname,
        width,
        height,
      ))
    );
  }

  private async normalize(
    input: Buffer,
    width: number,
    height: number,
  ): Promise<Buffer | null> {
    try {
      const image = sharp(input, {
        limitInputPixels: 1_048_576,
        animated: false,
      });
      const meta = await image.metadata();
      if (!['png', 'jpeg'].includes(meta.format ?? '')) {
        return null;
      }
      const output = await image
        .resize({
          width,
          height,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
      return output.length <= 64 * 1024 ? output : null;
    } catch {
      return null;
    }
  }
}
