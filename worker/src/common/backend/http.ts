/**
 * Backend HTTP infrastructure
 *
 * - Dedicated bounded undici Agent for backend (api.maiscorehub.bakapiano.com) calls
 *   so failed requests can't pile up unbounded sockets and leak fds.
 * - Built-in retry with exponential backoff for transient backend failures.
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
  // Job state PATCHes can include large score payloads and should not be
  // cut off by the bounded backend pool too aggressively.
  connect: { timeout: 5_000 },
  headersTimeout: 35_000,
  bodyTimeout: 35_000,
});

const BACKEND_RETRY_MAX_ATTEMPTS = 5;
const BACKEND_RETRY_BASE_DELAY_MS = 5_000;
const BACKEND_RETRY_MAX_DELAY_MS = 60_000;

type BackendFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

// ---------------------------------------------------------------------------
// ts-rest custom fetcher: bind dispatcher + retry transient failures
// ---------------------------------------------------------------------------

/**
 * A ts-rest `api` implementation that:
 *   1. Always routes through the bounded backend dispatcher.
 *   2. Retries transient backend failures with exponential backoff.
 *
 * Mirrors the body of the upstream `tsRestFetchApi` (see
 * @ts-rest/core/index.esm.mjs) closely so response handling stays identical.
 */
export const backendTsRestApi: NonNullable<
  Parameters<typeof import("@ts-rest/core").initClient>[1]["api"]
> = async ({
  path,
  method,
  headers,
  body,
  fetchOptions,
  route,
  validateResponse,
}) => {
  const apiSecret = process.env.API_SHARED_SECRET || process.env.ADMIN_PASSWORD;
  const authHeaders: Record<string, string> = apiSecret
    ? { "X-API-Secret": apiSecret }
    : {};

  const result = await backendFetchWithRetry(path, {
    ...(fetchOptions as BackendFetchInit | undefined),
    method,
    headers: { ...authHeaders, ...(headers as Record<string, string>) },
    body: body as any,
  });

  const contentType = result.headers.get("content-type") ?? "";
  if (contentType.includes("application/") && contentType.includes("json")) {
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

export async function backendFetchWithRetry(
  path: string,
  init: BackendFetchInit = {},
): Promise<Response> {
  return fetchBackendWithRetry(path, {
    ...init,
    dispatcher: backendDispatcher,
  });
}

async function fetchBackendWithRetry(
  path: string,
  init: BackendFetchInit,
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= BACKEND_RETRY_MAX_ATTEMPTS; attempt++) {
    let result: Response;
    try {
      result = (await undiciFetch(path, init)) as unknown as Response;
    } catch (err) {
      lastError = err;
      if (attempt >= BACKEND_RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      await delayBackendRetry(path, attempt, err);
      continue;
    }

    if (!isRetryableBackendStatus(result.status)) {
      return result;
    }

    lastError = new Error(`Backend HTTP ${result.status}`);
    if (attempt >= BACKEND_RETRY_MAX_ATTEMPTS) {
      return result;
    }

    await discardResponseBody(result);
    await delayBackendRetry(path, attempt, lastError);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Backend request failed");
}

function isRetryableBackendStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Best-effort cleanup before retrying
  }
}

async function delayBackendRetry(
  path: string,
  attempt: number,
  reason: unknown,
): Promise<void> {
  const delayMs = getBackendRetryDelayMs(attempt);
  console.warn(
    `[BackendHttp] Request failed, retrying in ${delayMs}ms (${attempt}/${BACKEND_RETRY_MAX_ATTEMPTS}) ${path}:`,
    reason,
  );
  await sleep(delayMs);
}

function getBackendRetryDelayMs(attempt: number): number {
  const baseDelay = Math.min(
    BACKEND_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    BACKEND_RETRY_MAX_DELAY_MS,
  );
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.round(baseDelay + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
