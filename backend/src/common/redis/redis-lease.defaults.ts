import type {
  RedisLeaseContext,
  RedisLeaseOptions,
} from './redis-lease.service';
import type { RedisLeaseService } from './redis-lease.service';

export function maintenanceLeaseOptions(
  name: string,
  hardTimeoutMs = 2 * 60_000,
): RedisLeaseOptions {
  return {
    name,
    ttlMs: 90_000,
    renewEveryMs: 30_000,
    hardTimeoutMs,
    abortGraceMs: 30_000,
  };
}

export async function runMaintenanceWithLease<T>(
  leases: RedisLeaseService,
  name: string,
  task: (context: RedisLeaseContext) => Promise<T>,
): Promise<void> {
  await leases.run(maintenanceLeaseOptions(name), task);
}
