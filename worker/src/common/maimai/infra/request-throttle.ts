import { AsyncLocalStorage } from "async_hooks";

import { REQUEST_PRIORITY_BACKGROUND } from "./request-priority.ts";

const REQUEST_INTERVAL_MS = 2_500;
const INITIAL_FREEZE_DURATION_MS = 60_000;
const MAX_FREEZE_DURATION_MS = 5 * 60_000;

interface BatchContext {
  count: number;
  label?: string;
}

interface ThrottleQueueEntry {
  priority: number;
  sequence: number;
  batch?: BatchContext;
  resolve: () => void;
}

interface ThrottleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultClock: ThrottleClock = {
  now: () => Date.now(),
  sleep,
};

export class RequestThrottle {
  private lastRequestStartTime = 0;
  private frozenUntil = 0;
  private throttleSequence = 0;
  private throttlePumpRunning = false;
  private nextFreezeDurationMs: number;
  private readonly batchStorage = new AsyncLocalStorage<BatchContext>();
  private readonly throttleQueue: ThrottleQueueEntry[] = [];
  private readonly clock: ThrottleClock;
  private readonly requestIntervalMs: number;
  private readonly freezeDurationMs: number;
  private readonly maxFreezeDurationMs: number;

  constructor(
    clock: ThrottleClock = defaultClock,
    requestIntervalMs = REQUEST_INTERVAL_MS,
    freezeDurationMs = INITIAL_FREEZE_DURATION_MS,
    maxFreezeDurationMs = MAX_FREEZE_DURATION_MS,
  ) {
    this.clock = clock;
    this.requestIntervalMs = requestIntervalMs;
    this.freezeDurationMs = freezeDurationMs;
    this.maxFreezeDurationMs = maxFreezeDurationMs;
    this.nextFreezeDurationMs = freezeDurationMs;
  }

  async runInBatch<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const existing = this.batchStorage.getStore();
    if (existing) {
      return fn();
    }

    const ctx = { count: 0, label };
    const batchStart = this.clock.now();
    try {
      return await this.batchStorage.run(ctx, fn);
    } finally {
      if (ctx.count > 0) {
        const charged =
          batchStart + (ctx.count - 1) * this.requestIntervalMs;
        if (charged > this.lastRequestStartTime) {
          this.lastRequestStartTime = charged;
        }
        console.log(
          `[MaimaiClient] batch${label ? ` "${label}"` : ""} done: ${ctx.count} requests in ${this.clock.now() - batchStart}ms; throttle credit ${ctx.count * this.requestIntervalMs}ms`,
        );
      }
    }
  }

  freeze(): void {
    const freezeDurationMs = this.nextFreezeDurationMs;
    this.frozenUntil = this.clock.now() + freezeDurationMs;
    this.nextFreezeDurationMs = Math.min(
      freezeDurationMs * 2,
      this.maxFreezeDurationMs,
    );
    console.log(
      `[MaimaiClient] 全局冻结 ${freezeDurationMs / 1000} 秒，所有请求将暂停`,
    );
  }

  resetFreezeBackoff(): void {
    this.nextFreezeDurationMs = this.freezeDurationMs;
  }

  waitForSlot(priority = REQUEST_PRIORITY_BACKGROUND): Promise<void> {
    const batch = this.batchStorage.getStore();
    return new Promise<void>((resolve) => {
      this.throttleQueue.push({
        priority,
        sequence: this.throttleSequence++,
        batch,
        resolve,
      });
      this.pumpThrottleQueue();
    });
  }

  sleep(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }

  private pumpThrottleQueue(): void {
    if (this.throttlePumpRunning) {
      return;
    }

    this.throttlePumpRunning = true;
    void this.pumpThrottleQueueLoop();
  }

  private async pumpThrottleQueueLoop(): Promise<void> {
    try {
      while (this.throttleQueue.length > 0) {
        const freezeRemaining = this.frozenUntil - this.clock.now();
        if (freezeRemaining > 0) {
          console.log(
            `[MaimaiClient] 请求等待全局冻结解除，剩余 ${Math.ceil(freezeRemaining / 1000)} 秒`,
          );
          await this.clock.sleep(freezeRemaining);
          continue;
        }

        const nextIndex = this.findNextThrottleQueueIndex();
        if (nextIndex < 0) {
          return;
        }

        const next = this.throttleQueue[nextIndex];
        const elapsed = this.clock.now() - this.lastRequestStartTime;
        const waitTime = this.requestIntervalMs - elapsed;
        if (!next.batch && waitTime > 0) {
          await this.clock.sleep(waitTime);
          continue;
        }

        const [entry] = this.throttleQueue.splice(nextIndex, 1);
        if (entry.batch) {
          entry.batch.count++;
          entry.resolve();
          continue;
        }

        this.lastRequestStartTime = this.clock.now();
        entry.resolve();
      }
    } finally {
      this.throttlePumpRunning = false;
      if (this.throttleQueue.length > 0) {
        this.pumpThrottleQueue();
      }
    }
  }

  private findNextThrottleQueueIndex(): number {
    let bestIndex = -1;
    for (let i = 0; i < this.throttleQueue.length; i++) {
      const current = this.throttleQueue[i];
      if (bestIndex < 0) {
        bestIndex = i;
        continue;
      }

      const best = this.throttleQueue[bestIndex];
      if (
        current.priority > best.priority ||
        (current.priority === best.priority &&
          current.sequence < best.sequence)
      ) {
        bestIndex = i;
      }
    }
    return bestIndex;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
