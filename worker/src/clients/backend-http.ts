/**
 * Backend HTTP infrastructure
 *
 * - Dedicated bounded undici Agent for backend (api.maiscorehub.bakapiano.com) calls
 *   so failed requests can't pile up unbounded sockets and leak fds.
 * - Shared health tracker that lets schedulers back off when the backend
 *   is unreachable, avoiding the avalanche of timed-out fetches that pinned
 *   CPU and OOM-killed the worker on 2026-04-28.
 * - Custom ts-rest `api` fetcher that wires both into every backend call.
 */

import { Agent, fetch as undiciFetch } from "undici";

// ---------------------------------------------------------------------------
// Bounded dispatcher
// ---------------------------------------------------------------------------

/**
 * NOTE: Intentionally separate from the global maimai dispatcher in
 * `services/maimai-client.ts`. Backend calls and maimai calls have very
 * different failure modes; sharing a pool means a backend outage can starve
 * maimai requests of sockets, and vice versa.
 */
const backendDispatcher = new Agent({
  // 4 sockets is plenty for a worker that issues ~1 backend req/s in steady
  // state. Caps the damage when backend hangs: at most 4 in-flight + 4 queued.
  connections: 4,
  pipelining: 1,
  // Keep-alive so steady-state traffic reuses TCP/TLS, but recycled often
  // enough that a flaky upstream gets fresh sockets.
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  // Aggressive timeouts: backend should respond in <1s normally. If anything
  // exceeds these, we'd rather fail fast than leak the socket for 10s+.
  connect: { timeout: 5_000 },
  headersTimeout: 10_000,
  bodyTimeout: 15_000,
});

export function getBackendDispatcher(): Agent {
  return backendDispatcher;
}

// ---------------------------------------------------------------------------
// Backend health tracker (consecutive-failure backoff)
// ---------------------------------------------------------------------------

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const FAILURE_THRESHOLD = 3;

let consecutiveFailures = 0;
let backoffUntil = 0;

/** Mark a successful backend call. Resets backoff. */
export function markBackendOk(): void {
  if (consecutiveFailures > 0) {
    console.log(
      `[BackendHealth] Recovered after ${consecutiveFailures} failure(s)`,
    );
  }
  consecutiveFailures = 0;
  backoffUntil = 0;
}

/** Mark a failed backend call. Trips backoff after FAILURE_THRESHOLD strikes. */
export function markBackendFail(err?: unknown): void {
  consecutiveFailures++;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    // Exponential backoff capped at MAX_BACKOFF_MS:
    //   3 fails -> 5s, 4 -> 10s, 5 -> 20s, 6 -> 40s, 7+ -> 60s
    const exp = Math.min(
      BASE_BACKOFF_MS * 2 ** (consecutiveFailures - FAILURE_THRESHOLD),
      MAX_BACKOFF_MS,
    );
    backoffUntil = Date.now() + exp;
    if (consecutiveFailures === FAILURE_THRESHOLD) {
      console.warn(
        `[BackendHealth] Backend unreachable (${consecutiveFailures} consecutive failures), entering backoff`,
        err,
      );
    }
  }
}

/** Returns true if callers should skip this tick due to backend backoff. */
export function shouldSkipForBackoff(): boolean {
  return Date.now() < backoffUntil;
}

/** Diagnostic accessor. */
export function getBackendHealth(): {
  consecutiveFailures: number;
  backoffRemainingMs: number;
} {
  return {
    consecutiveFailures,
    backoffRemainingMs: Math.max(0, backoffUntil - Date.now()),
  };
}

// ---------------------------------------------------------------------------
// ts-rest custom fetcher: bind dispatcher + observe health on every call
// ---------------------------------------------------------------------------

/**
 * A ts-rest `api` implementation that:
 *   1. Always routes through the bounded backend dispatcher.
 *   2. Reports success/failure to the health tracker so other schedulers
 *      can back off in unison.
 *
 * Mirrors the body of the upstream `tsRestFetchApi` (see
 * @ts-rest/core/index.esm.mjs) closely so response handling stays identical.
 */
export const backendTsRestApi: NonNullable<
  Parameters<typeof import("@ts-rest/core").initClient>[1]["api"]
> = async ({ path, method, headers, body, fetchOptions, route, validateResponse }) => {
  let result: Response;
  try {
    result = (await undiciFetch(path, {
      ...(fetchOptions as RequestInit | undefined),
      method,
      headers: headers as Record<string, string>,
      body: body as any,
      dispatcher: backendDispatcher,
    })) as unknown as Response;
  } catch (err) {
    markBackendFail(err);
    throw err;
  }

  markBackendOk();

  const contentType = result.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/") &&
    contentType.includes("json")
  ) {
    const response = {
      status: result.status,
      body: await result.json(),
      headers: result.headers,
    };
    const responseSchema = (route as any).responses?.[response.status];
    if (
      (validateResponse ?? (route as any).validateResponseOnClient) &&
      responseSchema &&
      typeof responseSchema.parse === "function"
    ) {
      return { ...response, body: responseSchema.parse(response.body) };
    }
    return response as any;
  }

  if (contentType.includes("text/")) {
    return {
      status: result.status,
      body: await result.text(),
      headers: result.headers,
    } as any;
  }

  return {
    status: result.status,
    body: await result.blob(),
    headers: result.headers,
  } as any;
};
