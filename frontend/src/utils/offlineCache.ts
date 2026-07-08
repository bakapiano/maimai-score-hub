/**
 * Offline cache utility for storing API responses in localStorage.
 * Caches profile and sync/latest data for offline viewing.
 */

const CACHE_PREFIX = "offline_cache_";

const KEYS = {
  profile: `${CACHE_PREFIX}profile`,
  syncLatest: `${CACHE_PREFIX}sync_latest`,
  syncLatestSummary: `${CACHE_PREFIX}sync_latest_summary`,
  musicList: `${CACHE_PREFIX}music_list`,
} as const;

function safeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {return null;}
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn("Failed to cache data", key, err);
  }
}

// ── Profile cache ──

export type CachedProfile = {
  avatarUrl: string | null;
  username: string | null;
  friendCode?: string | null;
};

export function cacheProfile(profile: CachedProfile): void {
  safeSet(KEYS.profile, profile);
}

export function getCachedProfile(): CachedProfile | null {
  return safeGet<CachedProfile>(KEYS.profile);
}

// ── Sync/Latest cache ──

export type CachedSyncLatest = {
  id?: string;
  scores: unknown[];
  createdAt?: string;
  updatedAt?: string;
  autoExportResult?: {
    divingFish?: { status: string; message?: string } | null;
    lxns?: { status: string; message?: string } | null;
  } | null;
};

export type CachedSyncLatestSummary = {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  scoreCount: number;
  autoExportResult?: CachedSyncLatest["autoExportResult"];
};

export function cacheSyncLatest(data: CachedSyncLatest): void {
  safeSet(KEYS.syncLatest, data);
  safeSet(KEYS.syncLatestSummary, {
    id: data.id,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    scoreCount: Array.isArray(data.scores) ? data.scores.length : 0,
    autoExportResult: data.autoExportResult ?? null,
  } satisfies CachedSyncLatestSummary);
}

export function getCachedSyncLatest(): CachedSyncLatest | null {
  return safeGet<CachedSyncLatest>(KEYS.syncLatest);
}

export function getCachedSyncLatestSummary(): CachedSyncLatestSummary | null {
  return safeGet<CachedSyncLatestSummary>(KEYS.syncLatestSummary);
}

// ── Music list cache ──

export type CachedMusicList<T = unknown> = {
  version: 1;
  cachedAt: string;
  items: T[];
};

export function cacheMusicList<T>(items: T[]): void {
  safeSet(KEYS.musicList, {
    version: 1,
    cachedAt: new Date().toISOString(),
    items,
  } satisfies CachedMusicList<T>);
}

export function getCachedMusicList<T = unknown>(): T[] | null {
  const cached = safeGet<CachedMusicList<T> | T[]>(KEYS.musicList);
  if (Array.isArray(cached)) {return cached;}
  if (cached && Array.isArray(cached.items)) {return cached.items;}
  return null;
}

// ── Offline mode flag ──

const OFFLINE_KEY = "offline_mode";

export function setOfflineMode(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(OFFLINE_KEY, "1");
    } else {
      localStorage.removeItem(OFFLINE_KEY);
    }
  } catch {
    // localStorage may be unavailable in private mode.
  }
}

export function isOfflineMode(): boolean {
  try {
    return localStorage.getItem(OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function hasOfflineData(): boolean {
  return getCachedProfile() !== null || getCachedSyncLatestSummary() !== null;
}
