import type {
  RedisLeaseContext,
  RedisLeaseOptions,
  RedisLeaseRunResult,
} from '../../../common/redis/redis-lease.service';
import { MusicAliasSyncService } from './music-alias-sync.service';

class FakeLeases {
  acquired = true;
  options: RedisLeaseOptions | null = null;

  async run<T>(
    options: RedisLeaseOptions,
    task: (context: RedisLeaseContext) => Promise<T>,
  ): Promise<RedisLeaseRunResult<T>> {
    this.options = options;
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

describe('MusicAliasSyncService', () => {
  it('uses its own alias-sync lease for a manual run', async () => {
    const aliases = {
      syncAll: jest.fn().mockResolvedValue({ sources: {} }),
    };
    const leases = new FakeLeases();
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const service = new MusicAliasSyncService(
      aliases as never,
      leases as never,
      config as never,
    );

    await service.syncNow();

    expect(aliases.syncAll).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(leases.options?.name).toBe('alias-sync');
  });

  it('returns conflict while another replica owns the alias lease', async () => {
    const aliases = { syncAll: jest.fn() };
    const leases = new FakeLeases();
    leases.acquired = false;
    const service = new MusicAliasSyncService(
      aliases as never,
      leases as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
    );

    await expect(service.syncNow()).rejects.toHaveProperty('status', 409);
  });
});
