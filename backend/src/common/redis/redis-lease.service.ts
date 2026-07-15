import { Injectable, Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { RedisService } from './redis.service';

export interface RedisLeaseOptions {
  name: string;
  ttlMs: number;
  renewEveryMs: number;
  hardTimeoutMs: number;
  abortGraceMs: number;
}

export interface RedisLeaseContext {
  signal: AbortSignal;
  assertActive: () => void;
}

export type RedisLeaseRunResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

export class RedisLeaseLostError extends Error {
  constructor(name: string, cause?: unknown) {
    super(`Redis lease lost: ${name}`, { cause });
    this.name = 'RedisLeaseLostError';
  }
}

export class RedisLeaseHardTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Redis lease task exceeded hard timeout: ${name} (${timeoutMs}ms)`);
    this.name = 'RedisLeaseHardTimeoutError';
  }
}

type LeaseState = {
  options: RedisLeaseOptions;
  key: string;
  token: string;
  controller: AbortController;
  finished: boolean;
  renewing: boolean;
  abortError: Error | null;
  renewTimer: NodeJS.Timeout | null;
  hardTimeoutTimer: NodeJS.Timeout | null;
  forceExitTimer: NodeJS.Timeout | null;
};

@Injectable()
export class RedisLeaseService {
  private readonly logger = new Logger(RedisLeaseService.name);

  constructor(private readonly redis: RedisService) {}

  async run<T>(
    options: RedisLeaseOptions,
    task: (context: RedisLeaseContext) => Promise<T>,
  ): Promise<RedisLeaseRunResult<T>> {
    this.validateOptions(options);
    const key = this.redis.key(`lock:${options.name}`);
    const token = `${hostname()}:${randomUUID()}`;
    if (!(await this.redis.setNx(key, token, options.ttlMs))) {
      this.logger.debug(`Redis lease busy name=${options.name}`);
      return { acquired: false };
    }

    const state = this.createState(options, key, token);
    this.startTimers(state);
    this.logger.debug(`Acquired Redis lease name=${options.name}`);

    try {
      try {
        const value = await task({
          signal: state.controller.signal,
          assertActive: () => this.assertActive(state),
        });
        if (state.abortError) {
          throw state.abortError;
        }
        return { acquired: true, value };
      } catch (error) {
        throw state.abortError ?? error;
      }
    } finally {
      state.finished = true;
      this.clearTimers(state);
      await this.redis.compareAndDelete(key, token).catch((error: unknown) => {
        this.logger.warn(
          `Failed to release Redis lease name=${options.name}: ${this.errorMessage(error)}`,
        );
      });
    }
  }

  private createState(
    options: RedisLeaseOptions,
    key: string,
    token: string,
  ): LeaseState {
    return {
      options,
      key,
      token,
      controller: new AbortController(),
      finished: false,
      renewing: false,
      abortError: null,
      renewTimer: null,
      hardTimeoutTimer: null,
      forceExitTimer: null,
    };
  }

  private startTimers(state: LeaseState): void {
    state.renewTimer = setInterval(() => {
      void this.renew(state);
    }, state.options.renewEveryMs);
    state.renewTimer.unref?.();

    state.hardTimeoutTimer = setTimeout(() => {
      this.abort(
        state,
        new RedisLeaseHardTimeoutError(
          state.options.name,
          state.options.hardTimeoutMs,
        ),
      );
    }, state.options.hardTimeoutMs);
    state.hardTimeoutTimer.unref?.();
  }

  private async renew(state: LeaseState): Promise<void> {
    if (state.finished || state.renewing) {
      return;
    }
    state.renewing = true;
    try {
      const renewed = await this.redis.compareAndPExpire(
        state.key,
        state.token,
        state.options.ttlMs,
      );
      if (!renewed) {
        this.abort(state, new RedisLeaseLostError(state.options.name));
      }
    } catch (error) {
      this.abort(state, new RedisLeaseLostError(state.options.name, error));
    } finally {
      state.renewing = false;
    }
  }

  private abort(state: LeaseState, error: Error): void {
    if (state.finished || state.abortError) {
      return;
    }
    state.abortError = error;
    state.controller.abort(error);
    this.logger.error(error.message);
    state.forceExitTimer = setTimeout(() => {
      this.logger.fatal(
        `Lease task did not stop within abort grace; terminating replica name=${state.options.name}`,
      );
      process.exit(1);
    }, state.options.abortGraceMs);
    state.forceExitTimer.unref?.();
  }

  private assertActive(state: LeaseState): void {
    if (!state.controller.signal.aborted) {
      return;
    }
    throw state.abortError ?? new RedisLeaseLostError(state.options.name);
  }

  private clearTimers(state: LeaseState): void {
    if (state.renewTimer) {
      clearInterval(state.renewTimer);
    }
    if (state.hardTimeoutTimer) {
      clearTimeout(state.hardTimeoutTimer);
    }
    if (state.forceExitTimer) {
      clearTimeout(state.forceExitTimer);
    }
  }

  private validateOptions(options: RedisLeaseOptions): void {
    if (
      options.ttlMs <= 0 ||
      options.renewEveryMs <= 0 ||
      options.renewEveryMs >= options.ttlMs ||
      options.hardTimeoutMs <= 0 ||
      options.abortGraceMs <= 0
    ) {
      throw new Error(`Invalid Redis lease options for ${options.name}`);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
