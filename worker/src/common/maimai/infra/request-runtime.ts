import { AsyncLocalStorage } from "async_hooks";

import { Agent, setGlobalDispatcher } from "undici";

import { REQUEST_PRIORITY_BACKGROUND } from "./request-priority.ts";
import { RequestThrottle } from "./request-throttle.ts";

setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    pipelining: 1,
    connections: 10,
  }),
);

export interface RequestLogEntry {
  url: string;
  method: string;
  statusCode: number;
  durationMs: number;
  bodySize: number | null;
  errorClass?: string;
}

export interface RequestContext {
  requestPriority?: number;
  onRequestLog?: (entry: RequestLogEntry) => void;
}

export class RequestRuntime {
  private readonly requestContextStorage =
    new AsyncLocalStorage<RequestContext>();
  private readonly throttle: RequestThrottle;

  constructor(throttle = new RequestThrottle()) {
    this.throttle = throttle;
  }

  getContext(): RequestContext {
    return this.requestContextStorage.getStore() ?? {};
  }

  runWithContext<T>(context: RequestContext, fn: () => T): T {
    const parent = this.requestContextStorage.getStore();
    return this.requestContextStorage.run({ ...parent, ...context }, fn);
  }

  getPriority(context: RequestContext): number {
    return context.requestPriority ?? REQUEST_PRIORITY_BACKGROUND;
  }

  runInBatch<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    return this.throttle.runInBatch(fn, label);
  }

  freeze(): void {
    this.throttle.freeze();
  }

  resetFreezeBackoff(): void {
    this.throttle.resetFreezeBackoff();
  }

  waitForSlot(priority = REQUEST_PRIORITY_BACKGROUND): Promise<void> {
    return this.throttle.waitForSlot(priority);
  }

  sleep(ms: number): Promise<void> {
    return this.throttle.sleep(ms);
  }
}

export const requestRuntime = new RequestRuntime();

export function getRequestContext(): RequestContext {
  return requestRuntime.getContext();
}

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return requestRuntime.runWithContext(context, fn);
}

export function runInBatch<T>(
  fn: () => Promise<T>,
  label?: string,
): Promise<T> {
  return requestRuntime.runInBatch(fn, label);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
