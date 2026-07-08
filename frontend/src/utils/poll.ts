/**
 * Polling helpers used by login flows (friend code / QR code) and any
 * other long-running async job endpoint.
 *
 *  - Default interval 1s.
 *  - 5xx failures are retried with exponential backoff. Only after
 *    `maxFailures` consecutive 5xx in a row is the poll considered
 *    dead.
 *  - The polled function returns either { done: true, value } to stop
 *    or { done: false } to keep polling.
 *  - Network errors (fetch reject) are treated like 5xx.
 */

export type PollOk<T> = { done: true; value: T };
export type PollWait = { done: false };
export type PollResult<T> = PollOk<T> | PollWait;

export interface PollOptions {
  /** Stable poll interval in ms. Default 1000. */
  intervalMs?: number;
  /** How many consecutive 5xx / network errors to tolerate. Default 5. */
  maxFailures?: number;
  /** Backoff schedule (ms) when a 5xx happens. Indexed by failure count. */
  backoff?: number[];
  /** Hard deadline; throws after this. Default 5 min. */
  timeoutMs?: number;
  /** Cancellation. */
  signal?: AbortSignal;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000];

export class PollAborted extends Error {
  constructor() {
    super("polling aborted");
    this.name = "PollAborted";
  }
}
export class PollTimeout extends Error {
  constructor() {
    super("polling timed out");
    this.name = "PollTimeout";
  }
}
export class PollDead extends Error {
  readonly lastError: unknown;
  constructor(lastError: unknown) {
    super(
      `polling failed (${lastError instanceof Error ? lastError.message : String(lastError)})`,
    );
    this.name = "PollDead";
    this.lastError = lastError;
  }
}

/**
 * Tag a fetch error so pollWithBackoff knows it was a 5xx vs a 4xx
 * (which should propagate immediately, NOT retry).
 */
export class HttpServerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpServerError";
    this.status = status;
  }
}
export class HttpClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "HttpClientError";
    this.status = status;
    this.body = body;
  }
}

export async function pollWithBackoff<T>(
  fn: () => Promise<PollResult<T>>,
  opts: PollOptions = {},
): Promise<T> {
  const interval = opts.intervalMs ?? 1_000;
  const maxFails = opts.maxFailures ?? 5;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);

  let consecutiveFails = 0;
  let lastErr: unknown = null;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {throw new PollAborted();}
    try {
      const r = await fn();
      consecutiveFails = 0; // success resets the counter
      if (r.done) {return r.value;}
      await sleep(interval, opts.signal);
      continue;
    } catch (err) {
      // 4xx → propagate immediately. Caller decides what to do.
      if (err instanceof HttpClientError) {throw err;}

      // 5xx / network → backoff and try again, unless we exhausted.
      lastErr = err;
      consecutiveFails++;
      if (consecutiveFails >= maxFails) {
        throw new PollDead(lastErr);
      }
      const wait = backoff[Math.min(consecutiveFails - 1, backoff.length - 1)];
      await sleep(wait, opts.signal);
    }
  }
  throw new PollTimeout();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PollAborted());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new PollAborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wraps `fetch` so the caller can plug it into pollWithBackoff. 2xx
 * resolves with the parsed JSON, 4xx throws HttpClientError (no retry),
 * 5xx / network throws HttpServerError (retried).
 */
export async function fetchForPoll(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // network errors look like 5xx for retry purposes
    throw new HttpServerError(
      0,
      err instanceof Error ? err.message : String(err),
    );
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (res.status >= 500) {
    throw new HttpServerError(res.status, `HTTP ${res.status}`);
  }
  if (res.status >= 400) {
    throw new HttpClientError(res.status, body, `HTTP ${res.status}`);
  }
  return { status: res.status, body };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
