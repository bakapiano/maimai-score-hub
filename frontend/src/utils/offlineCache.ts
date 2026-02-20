/**
 * Offline cache utility for storing API responses in localStorage.
 * Caches profile and sync/latest data for offline viewing.
 */

const CACHE_PREFIX = "offline_cache_";

const KEYS = {
  profile: `${CACHE_PREFIX}profile`,
  syncLatest: `${CACHE_PREFIX}sync_latest`,
} as const;

function safeGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
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
};

export function cacheProfile(profile: CachedProfile): void {
  safeSet(KEYS.profile, profile);
}

export function getCachedProfile(): CachedProfile | null {
  return safeGet<CachedProfile>(KEYS.profile);
}

// ── Sync/Latest cache ──

export type CachedSyncLatest = {
  scores: unknown[];
  createdAt?: string;
  updatedAt?: string;
};

export function cacheSyncLatest(data: CachedSyncLatest): void {
  safeSet(KEYS.syncLatest, data);
}

export function getCachedSyncLatest(): CachedSyncLatest | null {
  return safeGet<CachedSyncLatest>(KEYS.syncLatest);
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
  } catch {}
}

export function isOfflineMode(): boolean {
  try {
    return localStorage.getItem(OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function hasOfflineData(): boolean {
  return getCachedProfile() !== null || getCachedSyncLatest() !== null;
}
