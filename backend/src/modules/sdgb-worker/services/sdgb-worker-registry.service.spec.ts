import type {
  SdgbWorkerClass,
  SdgbWorkerHeartbeat,
} from '@maimai-score-hub/shared';

import { SdgbWorkerRegistryService } from './sdgb-worker-registry.service';

class MemoryRedis {
  readonly values = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  key(name: string): string {
    return 'test:' + name;
  }

  getJson<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return Promise.resolve(value ? (JSON.parse(value) as T) : null);
  }

  setJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.stringify(value));
    return Promise.resolve();
  }

  setNx(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) {
      return Promise.resolve(false);
    }
    this.values.set(key, value);
    return Promise.resolve(true);
  }

  compareAndDelete(key: string, value: string): Promise<boolean> {
    if (this.values.get(key) !== value) {
      return Promise.resolve(false);
    }
    this.values.delete(key);
    return Promise.resolve(true);
  }

  increment(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }

  keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return Promise.resolve(
      [...this.values.keys()].filter((key) => key.startsWith(prefix)),
    );
  }

  del(key: string): Promise<number> {
    return Promise.resolve(Number(this.values.delete(key)));
  }
}

function heartbeat(
  workerId: string,
  workerClass: SdgbWorkerClass,
  sequence = 0,
): SdgbWorkerHeartbeat {
  return {
    workerId,
    workerClass,
    ...(workerClass === 'recoverable'
      ? { autoRecoveryHookKind: 'router_reboot' }
      : {}),
    version: 'test',
    processGeneration: workerId + '-generation',
    sequence,
    lifecycleState: 'running',
    capabilities: ['probe', 'interactive'],
    laneMemberships: [],
    networkEpoch: 1,
    upstreamHealth: 'healthy',
    breakerState: 'closed',
    ...(workerClass === 'recoverable'
      ? { autoRecoveryState: 'idle' as const }
      : {}),
    ratePolicyMode: workerClass === 'stable' ? 'strict' : 'none',
    activeJobsByType: {},
    jobsClaimedDelta: 0,
  };
}

function service(redis: MemoryRedis): SdgbWorkerRegistryService {
  const config = {
    get: (key: string) => {
      if (
        key === 'SDGB_PROBE_PREFERRED_ACTIVE_COUNT' ||
        key === 'SDGB_INTERACTIVE_PREFERRED_ACTIVE_COUNT'
      ) {
        return 2;
      }
      if (
        key === 'SDGB_PROBE_FALLBACK_ACTIVE_COUNT' ||
        key === 'SDGB_INTERACTIVE_FALLBACK_ACTIVE_COUNT'
      ) {
        return 2;
      }
      return undefined;
    },
  };
  return new SdgbWorkerRegistryService(redis as never, config as never);
}

describe('SdgbWorkerRegistryService', () => {
  it('selects multiple preferred members and excludes fallback', async () => {
    const redis = new MemoryRedis();
    const registry = service(redis);
    await registry.heartbeat(heartbeat('recoverable-a', 'recoverable'));
    await registry.heartbeat(heartbeat('recoverable-b', 'recoverable'));
    const stable = await registry.heartbeat(heartbeat('stable-a', 'stable'));

    const probe = await registry.getDesiredMemberSet('probe');
    expect(probe?.members.map((member) => member.workerId)).toEqual([
      'recoverable-a',
      'recoverable-b',
    ]);
    expect(stable.desiredLaneMemberships.probe?.state).toBe('inactive');
    expect(stable.desiredLaneMemberships.interactive?.state).toBe('active');
  });

  it('activates Stable Probe fallback only after all Recoverable disappear', async () => {
    const redis = new MemoryRedis();
    const registry = service(redis);
    await registry.heartbeat(heartbeat('recoverable-a', 'recoverable'));
    await registry.heartbeat(heartbeat('stable-a', 'stable'));
    await registry.heartbeat(heartbeat('stable-b', 'stable'));

    await redis.del(redis.key('sdgb:workers:recoverable-a'));
    await registry.reconcile();

    const probe = await registry.getDesiredMemberSet('probe');
    expect(probe?.members.map((member) => member.workerId)).toEqual([
      'stable-a',
      'stable-b',
    ]);
  });

  it('rejects a Stable worker without strict rate policy', async () => {
    const registry = service(new MemoryRedis());
    const invalid = {
      ...heartbeat('stable-a', 'stable'),
      ratePolicyMode: 'none' as const,
    };

    await expect(registry.heartbeat(invalid)).rejects.toThrow(
      /ratePolicyMode=strict/,
    );
  });

  it('keeps a membership epoch stable while a member remains selected', async () => {
    const redis = new MemoryRedis();
    const registry = service(redis);
    await registry.heartbeat(heartbeat('recoverable-a', 'recoverable'));
    const before = await registry.getDesiredMemberSet('probe');
    await registry.heartbeat(heartbeat('recoverable-a', 'recoverable', 1));
    const after = await registry.getDesiredMemberSet('probe');

    expect(after?.members[0]?.membershipEpoch).toBe(
      before?.members[0]?.membershipEpoch,
    );
  });

  it('ignores non-JSON worker subkeys when listing registry entries', async () => {
    const redis = new MemoryRedis();
    const registry = service(redis);
    await registry.heartbeat(heartbeat('recoverable-a', 'recoverable'));
    redis.values.set(
      redis.key('sdgb:workers:recoverable-a:recovery-budget'),
      'raw-lock-token',
    );

    await expect(registry.listWorkers()).resolves.toHaveLength(1);
  });
});
