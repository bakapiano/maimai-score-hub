import { apiUrl } from "../api/baseUrl";
import {
  decodeJwtPayload,
  isLegacyAccessToken,
  shouldProactivelyRefresh,
  type DecodedAccessTokenPayload,
} from "./jwtPayload";

export {
  decodeJwtPayload,
  isLegacyAccessToken,
  shouldProactivelyRefresh,
  type DecodedAccessTokenPayload,
};

export const ACCESS_TOKEN_KEY = "netbot_token";
export const REFRESH_TOKEN_KEY = "netbot_refresh_token";

type SessionListener = (nextAccessToken: string | null) => void;

const listeners = new Set<SessionListener>();
let inFlightRefresh: Promise<string | null> | null = null;

function notifyListeners(nextAccessToken: string | null) {
  listeners.forEach((listener) => {
    try {
      listener(nextAccessToken);
    } catch {
      // Ignore subscriber errors.
    }
  });
}

export function subscribeSessionTokens(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function readRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function persistSessionTokens(
  token: string | null,
  refreshToken?: string | null,
) {
  try {
    if (token) {
      localStorage.setItem(ACCESS_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(ACCESS_TOKEN_KEY);
    }
    if (refreshToken !== undefined) {
      if (refreshToken) {
        localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      } else {
        localStorage.removeItem(REFRESH_TOKEN_KEY);
      }
    } else if (!token) {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    // localStorage may be unavailable.
  }
}

export function clearStoredSessionTokens() {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // localStorage may be unavailable.
  }
}

async function performRefresh(): Promise<string | null> {
  const refreshToken = readRefreshToken();
  const accessToken = readAccessToken();

  if (refreshToken) {
    try {
      const res = await fetch(apiUrl("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          token?: string;
          refreshToken?: string;
        };
        if (body.token && body.refreshToken) {
          persistSessionTokens(body.token, body.refreshToken);
          notifyListeners(body.token);
          return body.token;
        }
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        clearStoredSessionTokens();
        notifyListeners(null);
      }
      return null;
    } catch {
      return null;
    }
  }

  if (accessToken && isLegacyAccessToken(accessToken)) {
    try {
      const res = await fetch(apiUrl("/auth/upgrade"), {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          token?: string;
          refreshToken?: string;
        };
        if (body.token && body.refreshToken) {
          persistSessionTokens(body.token, body.refreshToken);
          notifyListeners(body.token);
          return body.token;
        }
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        // Legacy token may already be expired or upgraded elsewhere.
        return null;
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

export function refreshSessionTokens(): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = performRefresh().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

export async function revokeCurrentSession(): Promise<void> {
  const refreshToken = readRefreshToken();
  const accessToken = readAccessToken();
  clearStoredSessionTokens();
  notifyListeners(null);

  if (!refreshToken && !accessToken) {
    return;
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    await fetch(apiUrl("/auth/logout"), {
      method: "POST",
      headers,
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    });
  } catch {
    // Best-effort revocation; local session is already cleared.
  }
}
