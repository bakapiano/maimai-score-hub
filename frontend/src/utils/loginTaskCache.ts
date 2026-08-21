export const LOGIN_TASK_CACHE_TTL_MS = 5 * 60_000;

const FRIEND_LOGIN_CACHE_KEY = "pendingFriendCodeLogin";
const QR_LOGIN_CACHE_KEY = "pendingQrLogin";
const LEGACY_FRIEND_LOGIN_KEYS = [
  "pendingLoginJobId",
  "pendingLoginBotFriendCode",
  "pendingLoginCreatedAt",
  "pendingLoginExpiresAt",
] as const;
const LEGACY_QR_LOGIN_KEYS = ["pendingQrLoginAttemptId"] as const;

export type LoginTaskStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

type CacheEnvelope<T> = {
  version: 1;
  cachedAt: number;
  expiresAt: number;
  value: T;
};

export type PendingFriendLogin = {
  jobId: string;
  botFriendCode: string;
  createdAt: string;
  expiresAt: number;
};

export type PendingQrLogin = {
  attemptId: string;
  expiresAt: number;
};

function browserStorage(): LoginTaskStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: LoginTaskStorage | null) {
  return storage === undefined ? browserStorage() : storage;
}

export function calculateLoginTaskExpiry(
  createdAt: string | null | undefined,
  now = Date.now(),
): number {
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const createdDeadline = Number.isFinite(createdAtMs)
    ? createdAtMs + LOGIN_TASK_CACHE_TTL_MS
    : Number.POSITIVE_INFINITY;
  return Math.min(now + LOGIN_TASK_CACHE_TTL_MS, createdDeadline);
}

function isFreshEnvelope<T>(
  envelope: CacheEnvelope<T>,
  now: number,
): boolean {
  return (
    envelope.version === 1 &&
    Number.isFinite(envelope.cachedAt) &&
    Number.isFinite(envelope.expiresAt) &&
    envelope.cachedAt <= now &&
    envelope.expiresAt > now &&
    envelope.expiresAt > envelope.cachedAt &&
    envelope.expiresAt - envelope.cachedAt <= LOGIN_TASK_CACHE_TTL_MS
  );
}

function readEnvelope<T>(
  key: string,
  now: number,
  storage?: LoginTaskStorage | null,
): CacheEnvelope<T> | null {
  const target = resolveStorage(storage);
  if (!target) {
    return null;
  }

  try {
    const raw = target.getItem(key);
    if (!raw) {
      return null;
    }
    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    if (!isFreshEnvelope(envelope, now)) {
      target.removeItem(key);
      return null;
    }
    return envelope;
  } catch {
    try {
      target.removeItem(key);
    } catch {
      // Storage cleanup is best effort.
    }
    return null;
  }
}

function writeEnvelope<T>(
  key: string,
  value: T,
  expiresAt: number,
  now: number,
  storage?: LoginTaskStorage | null,
) {
  const target = resolveStorage(storage);
  if (!target) {
    return;
  }

  const boundedExpiresAt = Math.min(
    expiresAt,
    now + LOGIN_TASK_CACHE_TTL_MS,
  );
  try {
    target.setItem(
      key,
      JSON.stringify({
        version: 1,
        cachedAt: now,
        expiresAt: boundedExpiresAt,
        value,
      } satisfies CacheEnvelope<T>),
    );
  } catch {
    // Storage writes are best effort.
  }
}

function removeKeys(
  keys: readonly string[],
  storage?: LoginTaskStorage | null,
) {
  const target = resolveStorage(storage);
  if (!target) {
    return;
  }
  for (const key of keys) {
    try {
      target.removeItem(key);
    } catch {
      // Storage cleanup is best effort.
    }
  }
}

export function clearPendingFriendLogin(
  storage?: LoginTaskStorage | null,
) {
  removeKeys(
    [FRIEND_LOGIN_CACHE_KEY, ...LEGACY_FRIEND_LOGIN_KEYS],
    storage,
  );
}

export function readPendingFriendLogin(
  now = Date.now(),
  storage?: LoginTaskStorage | null,
): PendingFriendLogin | null {
  removeKeys(LEGACY_FRIEND_LOGIN_KEYS, storage);
  const envelope = readEnvelope<{
    jobId?: unknown;
    botFriendCode?: unknown;
    createdAt?: unknown;
  }>(FRIEND_LOGIN_CACHE_KEY, now, storage);
  if (
    !envelope ||
    typeof envelope.value?.jobId !== "string" ||
    envelope.value.jobId.length === 0
  ) {
    if (envelope) {
      clearPendingFriendLogin(storage);
    }
    return null;
  }

  return {
    jobId: envelope.value.jobId,
    botFriendCode:
      typeof envelope.value.botFriendCode === "string"
        ? envelope.value.botFriendCode
        : "",
    createdAt:
      typeof envelope.value.createdAt === "string"
        ? envelope.value.createdAt
        : "",
    expiresAt: envelope.expiresAt,
  };
}

export function persistPendingFriendLogin(
  jobId: string,
  botFriendCode: string,
  createdAt: string,
  now = Date.now(),
  storage?: LoginTaskStorage | null,
): PendingFriendLogin {
  const expiresAt = calculateLoginTaskExpiry(createdAt, now);
  clearPendingFriendLogin(storage);
  writeEnvelope(
    FRIEND_LOGIN_CACHE_KEY,
    { jobId, botFriendCode, createdAt },
    expiresAt,
    now,
    storage,
  );
  return { jobId, botFriendCode, createdAt, expiresAt };
}

export function clearPendingQrLogin(storage?: LoginTaskStorage | null) {
  removeKeys([QR_LOGIN_CACHE_KEY, ...LEGACY_QR_LOGIN_KEYS], storage);
}

export function readPendingQrLogin(
  now = Date.now(),
  storage?: LoginTaskStorage | null,
): PendingQrLogin | null {
  removeKeys(LEGACY_QR_LOGIN_KEYS, storage);
  const envelope = readEnvelope<{ attemptId?: unknown }>(
    QR_LOGIN_CACHE_KEY,
    now,
    storage,
  );
  if (
    !envelope ||
    typeof envelope.value?.attemptId !== "string" ||
    envelope.value.attemptId.length === 0
  ) {
    if (envelope) {
      clearPendingQrLogin(storage);
    }
    return null;
  }
  return {
    attemptId: envelope.value.attemptId,
    expiresAt: envelope.expiresAt,
  };
}

export function persistPendingQrLogin(
  attemptId: string,
  now = Date.now(),
  storage?: LoginTaskStorage | null,
): PendingQrLogin {
  const expiresAt = now + LOGIN_TASK_CACHE_TTL_MS;
  clearPendingQrLogin(storage);
  writeEnvelope(QR_LOGIN_CACHE_KEY, { attemptId }, expiresAt, now, storage);
  return { attemptId, expiresAt };
}
