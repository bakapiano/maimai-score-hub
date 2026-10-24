import type { Request, Response } from 'express';
import type { ArgumentsHost } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import { sendStatsCard, StatsCardExceptionFilter } from './stats-card.http';

const publicPolicy = 'public, max-age=300, s-maxage=7200, must-revalidate';
const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const image = { gzip: gzipSync(svg), etag: 'W/"test-card"' };
function response() {
  return {
    setHeader: jest.fn(),
    vary: jest.fn(),
    end: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}
function request(encoding: string, etag?: string) {
  return {
    headers: { 'if-none-match': etag },
    acceptsEncodings: () => encoding,
  } as unknown as Request;
}

describe('stats card HTTP cache policy', () => {
  it.each(['gzip', 'identity'])(
    'allows two-hour CDN caching for %s responses',
    async (encoding) => {
      const res = response();
      await sendStatsCard(
        request(encoding),
        res as unknown as Response,
        image,
        true,
      );
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', publicPolicy);
      expect(res.setHeader).toHaveBeenCalledWith('ETag', image.etag);
      expect(res.vary).toHaveBeenCalledWith('Accept-Encoding');
      expect(res.end).toHaveBeenCalledWith(
        encoding === 'gzip' ? image.gzip : Buffer.from(svg),
      );
    },
  );
  it('renews the same policy on a conditional 304 response', async () => {
    const res = response();
    await sendStatsCard(
      request('identity', image.etag),
      res as unknown as Response,
      image,
      true,
    );
    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', publicPolicy);
    expect(res.end).toHaveBeenCalledWith();
  });
  it('never caches a private preview or turns it into 304', async () => {
    const res = response();
    await sendStatsCard(
      request('identity', image.etag),
      res as unknown as Response,
      image,
      false,
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).not.toHaveBeenCalled();
  });
  it('never caches a revoked/missing card error', () => {
    const res = response();
    const host = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost;
    new StatsCardExceptionFilter().catch(new NotFoundException(), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
