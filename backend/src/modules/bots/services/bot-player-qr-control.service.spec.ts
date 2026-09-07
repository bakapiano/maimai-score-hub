import { ConflictException } from '@nestjs/common';

import { BotPlayerQrControlService } from './bot-player-qr-control.service';

function createHarness() {
  const values = new Map<string, unknown>();
  const redis = {
    key: jest.fn((name: string) => `maimai:${name}`),
    getJson: jest.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setJson: jest.fn((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    compareAndSetJson: jest.fn(
      (key: string, expected: unknown, value: unknown, ttlSeconds: number) => {
        if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
          return Promise.reject(new Error('Invalid mock TTL'));
        }
        if (JSON.stringify(values.get(key)) !== JSON.stringify(expected)) {
          return Promise.resolve(false);
        }
        values.set(key, value);
        return Promise.resolve(true);
      },
    ),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'AUTH_JWT_SECRET' ? 'unit-test-secret' : undefined,
    ),
  };
  return {
    service: new BotPlayerQrControlService(redis as never, config as never),
    redis,
    values,
  };
}

describe('BotPlayerQrControlService', () => {
  it('creates a short-lived request and stores encrypted QR content', async () => {
    const { service, redis, values } = createHarness();
    const requested = await service.request('123456789');

    expect(requested).toMatchObject({
      friendCode: '123456789',
      requested: true,
      status: 'requested',
      qrCode: null,
    });
    expect(requested.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(redis.setJson).toHaveBeenCalledWith(
      'maimai:android:player-qr:123456789',
      expect.any(Object),
      { ttlSeconds: 600 },
    );

    const processing = await service.update('123456789', {
      requestId: requested.requestId!,
      status: 'processing',
    });
    expect(processing.status).toBe('processing');

    const rawQr = `SGWCMAID${'A'.repeat(76)}`;
    const completed = await service.update('123456789', {
      requestId: requested.requestId!,
      status: 'completed',
      qrCode: rawQr,
      qrExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(completed).toMatchObject({
      requested: false,
      status: 'completed',
      qrCode: rawQr,
    });

    const stored = values.get('maimai:android:player-qr:123456789') as Record<
      string,
      unknown
    >;
    expect(stored.qrCodeEncrypted).toEqual(expect.stringMatching(/^v1\./));
    expect(JSON.stringify(stored)).not.toContain(rawQr);
    await expect(service.get('123456789')).resolves.toMatchObject({
      status: 'completed',
      qrCode: rawQr,
    });
  });

  it('rejects updates for a replaced request', async () => {
    const { service } = createHarness();
    await service.request('123456789');
    await expect(
      service.update('123456789', {
        requestId: '11111111-1111-4111-8111-111111111111',
        status: 'processing',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns an idle view after Redis expiry', async () => {
    const { service } = createHarness();
    await expect(service.get('123456789')).resolves.toEqual({
      friendCode: '123456789',
      requested: false,
      requestId: null,
      status: 'idle',
      requestedAt: null,
      requestExpiresAt: null,
      processingAt: null,
      completedAt: null,
      qrCode: null,
      qrExpiresAt: null,
      errorCode: null,
    });
  });
});

describe('BotPlayerQrControlService concurrent updates', () => {
  it('fences an in-flight response when another replica replaces the request', async () => {
    const { service, redis } = createHarness();
    const original = await service.request('123456789');
    const compareAndSet = redis.compareAndSetJson.getMockImplementation()!;
    let replacementId: string | null = null;
    redis.compareAndSetJson.mockImplementationOnce(async (...args) => {
      replacementId = (await service.request('123456789')).requestId;
      return compareAndSet(...args);
    });
    await expect(
      service.update('123456789', {
        requestId: original.requestId!,
        status: 'completed',
        qrCode: 'old-qr',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.get('123456789')).resolves.toMatchObject({
      requestId: replacementId,
      status: 'requested',
      qrCode: null,
    });
  });

  it('keeps an expired request expired when a response is already in flight', async () => {
    const { service, redis, values } = createHarness();
    const requested = await service.request('123456789');
    redis.compareAndSetJson.mockImplementationOnce((key) => {
      values.delete(key);
      return Promise.resolve(false);
    });
    await expect(
      service.update('123456789', {
        requestId: requested.requestId!,
        status: 'processing',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.get('123456789')).resolves.toMatchObject({
      status: 'idle',
    });
  });

  it('preserves the original request deadline when processing is retried', async () => {
    const { service, redis } = createHarness();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const requested = await service.request('123456789');
      clock.mockReturnValue(
        new Date(requested.requestExpiresAt!).getTime() - 45_000,
      );
      await service.update('123456789', {
        requestId: requested.requestId!,
        status: 'processing',
      });
      expect(redis.compareAndSetJson).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
        45,
      );
    } finally {
      clock.mockRestore();
    }
  });
});
