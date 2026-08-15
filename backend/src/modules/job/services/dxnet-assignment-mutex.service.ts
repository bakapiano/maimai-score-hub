import { Injectable } from '@nestjs/common';

import {
  RedisLeaseService,
  type RedisLeaseContext,
} from '../../../common/redis/redis-lease.service';

const ASSIGNMENT_MUTEX_TTL_MS = 15_000;
const ASSIGNMENT_MUTEX_RENEW_MS = 5_000;
const ASSIGNMENT_MUTEX_HARD_TIMEOUT_MS = 30_000;
const ASSIGNMENT_MUTEX_ABORT_GRACE_MS = 5_000;
const ASSIGNMENT_MUTEX_WAIT_MS = 2_000;
const RETRY_MS = 50;

export type AssignmentMutexResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

@Injectable()
export class DxnetAssignmentMutexService {
  constructor(private readonly leases: RedisLeaseService) {}

  async run<T>(
    botFriendCode: string,
    task: (context: RedisLeaseContext) => Promise<T>,
  ): Promise<AssignmentMutexResult<T>> {
    const deadline = Date.now() + ASSIGNMENT_MUTEX_WAIT_MS;
    while (Date.now() <= deadline) {
      const result = await this.leases.run(
        {
          name: `dxnet-assignment:${botFriendCode}`,
          ttlMs: ASSIGNMENT_MUTEX_TTL_MS,
          renewEveryMs: ASSIGNMENT_MUTEX_RENEW_MS,
          hardTimeoutMs: ASSIGNMENT_MUTEX_HARD_TIMEOUT_MS,
          abortGraceMs: ASSIGNMENT_MUTEX_ABORT_GRACE_MS,
        },
        task,
      );
      if (result.acquired) {
        return result;
      }
      await sleep(Math.min(RETRY_MS, Math.max(1, deadline - Date.now())));
    }
    return { acquired: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
