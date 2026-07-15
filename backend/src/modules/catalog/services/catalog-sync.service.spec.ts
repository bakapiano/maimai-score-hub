import type {
  RedisLeaseContext,
  RedisLeaseOptions,
  RedisLeaseRunResult,
} from '../../../common/redis/redis-lease.service';
import { CatalogSyncService } from './catalog-sync.service';

class FakeLeases {
  acquired = true;

  async run<T>(
    _options: RedisLeaseOptions,
    task: (context: RedisLeaseContext) => Promise<T>,
  ): Promise<RedisLeaseRunResult<T>> {
    if (!this.acquired) {
      return { acquired: false };
    }
    const signal = new AbortController().signal;
    return {
      acquired: true,
      value: await task({
        signal,
        assertActive: () => signal.throwIfAborted(),
      }),
    };
  }
}

function createHarness() {
  const calls: string[] = [];
  const music = {
    syncMusicData: jest.fn().mockImplementation(() => {
      calls.push('music');
      return Promise.resolve({ total: 2 });
    }),
  };
  const covers = {
    syncAll: jest.fn().mockImplementation(() => {
      calls.push('covers');
      return Promise.resolve({ total: 2, saved: 0, skipped: 2, failed: 0 });
    }),
    forceSyncAll: jest.fn(),
    backfillLocalVariants: jest.fn(),
  };
  const leases = new FakeLeases();
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new CatalogSyncService(
    music as never,
    covers as never,
    leases as never,
    config as never,
  );
  return { service, music, covers, leases, calls };
}

describe('CatalogSyncService', () => {
  it('runs music first and then only fills missing covers', async () => {
    const { service, covers, calls } = createHarness();
    const scheduled = service as unknown as {
      runScheduled: () => Promise<void>;
    };

    await scheduled.runScheduled();

    expect(calls).toEqual(['music', 'covers']);
    expect(covers.syncAll).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(covers.forceSyncAll).not.toHaveBeenCalled();
  });

  it('returns conflict for a manual sync when another replica owns it', async () => {
    const { service, leases } = createHarness();
    leases.acquired = false;

    await expect(service.syncCovers(false)).rejects.toHaveProperty(
      'status',
      409,
    );
  });
});
