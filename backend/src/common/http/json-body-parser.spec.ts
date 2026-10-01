import express from 'express';
import { gzipSync } from 'node:zlib';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createJsonBodyParser } from './json-body-parser';

describe('worker JSON result uploads', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(createJsonBodyParser('1mb'));
    app.patch('/result', (req, res) => {
      res.json({
        rows: (req.body as { musicDetails: unknown[] }).musicDetails.length,
      });
    });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/result`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each([false, true])(
    'accepts complete result JSON with gzip=%s',
    async (compressed) => {
      const json = JSON.stringify({
        musicDetails: Array.from({ length: 4390 }, (_, musicId) => ({
          musicId,
          achievement: 1005000,
          note: 'score'.repeat(15),
        })),
      });
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(compressed ? { 'content-encoding': 'gzip' } : {}),
        },
        body: compressed ? new Uint8Array(gzipSync(json)) : json,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ rows: 4390 });
    },
  );

  it('enforces the decompressed size limit', async () => {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: new Uint8Array(
        gzipSync(
          JSON.stringify({ musicDetails: ['x'.repeat(2 * 1024 * 1024)] }),
        ),
      ),
    });
    expect(response.status).toBe(413);
    await response.text();
  });

  it('rejects corrupt gzip before business processing', async () => {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: 'invalid compressed body',
    });
    expect(response.status).toBe(400);
    await response.text();
  });
});
