import { syncApi } from "./appClient";

const LATEST_SYNC_CACHE_TTL_MS = 10_000;

export type LatestSyncResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
};

type FetchLatestSyncOptions = {
  force?: boolean;
};

const latestSyncRequests = new Map<string, Promise<LatestSyncResult<unknown>>>();
const latestSyncCache = new Map<
  string,
  { value: LatestSyncResult<unknown>; expiresAt: number }
>();

export async function fetchLatestSync<T>(
  token: string,
  options: FetchLatestSyncOptions = {},
): Promise<LatestSyncResult<T>> {
  if (!options.force) {
    const cached = latestSyncCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as LatestSyncResult<T>;
    }

    const inflight = latestSyncRequests.get(token);
    if (inflight) {
      return inflight as Promise<LatestSyncResult<T>>;
    }
  }

  const request = syncApi
    .latest({
      headers: { authorization: `Bearer ${token}` },
    })
    .then((res: { status: number; body?: unknown }) => ({
      ok: res.status === 200,
      status: res.status,
      data: (res.body ?? null) as unknown,
    }))
    .then((result: LatestSyncResult<unknown>) => {
      if (result.status === 200) {
        latestSyncCache.set(token, {
          value: result,
          expiresAt: Date.now() + LATEST_SYNC_CACHE_TTL_MS,
        });
      }
      return result;
    })
    .finally(() => {
      if (latestSyncRequests.get(token) === request) {
        latestSyncRequests.delete(token);
      }
    });

  latestSyncRequests.set(token, request);
  return request as Promise<LatestSyncResult<T>>;
}
