import { Catch, HttpException, Injectable } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ByteLru } from './byte-lru';
import type { StatsCardImage } from './stats-card.service';
const decompress = promisify(gunzip);

@Catch()
export class StatsCardExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    response.setHeader('Cache-Control', 'no-store');
    if (status === 429 || status === 503) {
      response.setHeader('Retry-After', '5');
    }
    response.status(status).json({
      statusCode: status,
      message:
        status === 404
          ? '分享卡片不存在或已关闭'
          : status === 401
            ? '请先登录'
            : status === 400
              ? '无效的卡片参数'
              : '卡片暂不可用，请稍后重试',
    });
  }
}

@Injectable()
export class StatsCardRateLimit {
  private readonly counts = new ByteLru<number>(64 * 1024, 2048, 60_000);
  take(key: string, limit: number) {
    const current = this.counts.get(key) ?? 0;
    if (current >= limit) {
      throw new HttpException('请求过于频繁', 429);
    }
    // Fixed minute buckets, despite the LRU's refresh-on-set expiration.
    this.counts.set(key, current + 1, 32);
  }
}

export async function sendStatsCard(
  req: Request,
  res: Response,
  image: StatsCardImage,
  publicImage: boolean,
) {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', publicImage ? 'public, no-cache' : 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('ETag', image.etag);
  res.vary('Accept-Encoding');
  const matches = req.headers['if-none-match']
    ?.split(',')
    .some(
      (part) =>
        part.trim() === '*' ||
        part.trim().replace(/^W\//, '') === image.etag.replace(/^W\//, ''),
    );
  if (publicImage && matches) {
    res.status(304).end();
    return;
  }
  if (req.acceptsEncodings('gzip') === 'gzip') {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(image.gzip);
  } else {
    res.end(await decompress(image.gzip));
  }
}
