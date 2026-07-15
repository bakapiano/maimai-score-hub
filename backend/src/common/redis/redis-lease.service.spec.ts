import {
  RedisLeaseHardTimeoutError,
  RedisLeaseLostError,
  RedisLeaseService,
} from './redis-lease.service';

function createHarness() {
  let acquiredToken = '';
  const redis = {
    key: jest.fn((name: string) => `maimai:${name}`),
    setNx: jest.fn((_key: string, value: string) => {
      acquiredToken = value;
      return Promise.resolve(true);
    }),
    compareAndPExpire: jest.fn().mockResolvedValue(true),
    compareAndDelete: jest.fn().mockResolvedValue(true),
  };
  return {
    redis,
    service: new RedisLeaseService(redis as never),
    acquiredToken: () => acquiredToken,
  };
}

const options = {
  name: 'test-task',
  ttlMs: 90,
  renewEveryMs: 30,
  hardTimeoutMs: 120,
  abortGraceMs: 60,
};

describe('RedisLeaseService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns without running when another replica owns the lease', async () => {
    const { redis, service } = createHarness();
    redis.setNx.mockResolvedValue(false);
    const task = jest.fn().mockResolvedValue('unused');

    await expect(service.run(options, task)).resolves.toEqual({
      acquired: false,
    });
    expect(task).not.toHaveBeenCalled();
    expect(redis.compareAndDelete).not.toHaveBeenCalled();
  });

  it('renews and releases only with its owner token', async () => {
    jest.useFakeTimers();
    const { redis, service, acquiredToken } = createHarness();
    let finish: ((value: string) => void) | undefined;
    const task = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const run = service.run(options, task);
    await jest.advanceTimersByTimeAsync(30);
    expect(redis.compareAndPExpire).toHaveBeenCalledTimes(1);

    finish?.('done');
    await expect(run).resolves.toEqual({ acquired: true, value: 'done' });
    expect(redis.compareAndPExpire).toHaveBeenCalledWith(
      'maimai:lock:test-task',
      acquiredToken(),
      90,
    );
    expect(redis.compareAndDelete).toHaveBeenCalledWith(
      'maimai:lock:test-task',
      acquiredToken(),
    );
  });

  it('aborts cooperative work at the hard timeout', async () => {
    jest.useFakeTimers();
    const { service } = createHarness();
    const run = service.run(options, async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Lease aborted'),
            ),
          { once: true },
        );
      });
      return 'unreachable';
    });
    const rejected = expect(run).rejects.toBeInstanceOf(
      RedisLeaseHardTimeoutError,
    );

    await jest.advanceTimersByTimeAsync(120);
    await rejected;
  });

  it('aborts when renewal proves ownership was lost', async () => {
    jest.useFakeTimers();
    const { redis, service } = createHarness();
    redis.compareAndPExpire.mockResolvedValue(false);
    const run = service.run(options, async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('Lease aborted'),
            ),
          { once: true },
        );
      });
      return 'unreachable';
    });
    const rejected = expect(run).rejects.toBeInstanceOf(RedisLeaseLostError);

    await jest.advanceTimersByTimeAsync(30);
    await rejected;
  });
});
