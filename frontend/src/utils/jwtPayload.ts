const PROACTIVE_REFRESH_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

export type DecodedAccessTokenPayload = {
  sub?: string;
  friendCode?: string;
  sid?: string;
  typ?: string;
  iat?: number;
  exp?: number;
};

export function decodeJwtPayload(
  token: string | null | undefined,
): DecodedAccessTokenPayload | null {
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as DecodedAccessTokenPayload;
  } catch {
    return null;
  }
}

export function isLegacyAccessToken(token: string | null | undefined): boolean {
  const payload = decodeJwtPayload(token);
  return payload !== null && !payload.sid;
}

export function shouldProactivelyRefresh(
  token: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return false;
  }
  return payload.exp * 1000 - nowMs <= PROACTIVE_REFRESH_THRESHOLD_MS;
}
