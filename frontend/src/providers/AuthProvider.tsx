import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usersApi } from "../api/appClient";
import {
  AuthContext,
  type AuthProfile,
  type ClearTokenOptions,
  type RefreshProfileOptions,
} from "./AuthContext";
import {
  isOfflineMode,
  cacheProfile,
  setOfflineMode as persistOfflineMode,
} from "../utils/offlineCache";
import {
  clearStoredSessionTokens,
  isLegacyAccessToken,
  persistSessionTokens,
  readAccessToken,
  readRefreshToken,
  refreshSessionTokens,
  revokeCurrentSession,
  shouldProactivelyRefresh,
  subscribeSessionTokens,
} from "../utils/authSession";

const PROFILE_CACHE_TTL_MS = 10_000;

const profileRequests = new Map<string, Promise<AuthProfile | null>>();
const profileCache = new Map<
  string,
  { value: AuthProfile | null; expiresAt: number }
>();

class UnauthorizedProfileError extends Error {}

function persistLoadedProfileHints(nextProfile: AuthProfile | null) {
  if (!nextProfile) {
    return;
  }
  try {
    if (nextProfile.friendCode) {
      localStorage.setItem("lastFriendCode", nextProfile.friendCode);
    }
    if (nextProfile.username) {
      localStorage.setItem("lastUsername", nextProfile.username);
    }
  } catch {
    // ignore
  }
  if (nextProfile.profile) {
    cacheProfile({
      avatarUrl: nextProfile.profile.avatarUrl,
      username: nextProfile.profile.username,
      friendCode: nextProfile.friendCode,
    });
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() =>
    readAccessToken(),
  );
  const [offline, setOfflineState] = useState(() => isOfflineMode());
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeSessionTokens((nextAccessToken) => {
      setTokenState((prev) => (prev === nextAccessToken ? prev : nextAccessToken));
      if (!nextAccessToken) {
        setProfile(null);
      }
    });
  }, []);

  const setToken = useCallback(
    (next: string | null, refreshToken?: string | null) => {
      setProfile(null);
      setProfileError(null);
      if (next) {
        setOfflineState(false);
        persistOfflineMode(false);
      }
      setTokenState(next);
      persistSessionTokens(next, refreshToken);
    },
    [],
  );

  const clearToken = useCallback((options?: ClearTokenOptions) => {
    setProfile(null);
    setProfileError(null);
    setTokenState(null);
    if (options?.revoke === false) {
      clearStoredSessionTokens();
      return;
    }
    void revokeCurrentSession();
  }, []);

  const setOffline = useCallback((v: boolean) => {
    setOfflineState(v);
    persistOfflineMode(v);
  }, []);

  const refreshProfile = useCallback(
    async (options: RefreshProfileOptions = {}) => {
      if (!token || offline) {
        setProfileLoading(false);
        if (!token) {
          setProfile(null);
        }
        return null;
      }

      const cached = profileCache.get(token);
      if (!options.force && cached && cached.expiresAt > Date.now()) {
        setProfile(cached.value);
        return cached.value;
      }

      setProfileLoading(true);
      setProfileError(null);

      let request = profileRequests.get(token);
      if (!request || options.force) {
        const nextRequest: Promise<AuthProfile | null> = usersApi
          .profile({
            headers: { authorization: `Bearer ${token}` },
          })
          .then((res: { status: number; body?: unknown }) => {
            if (res.status === 401 || res.status === 403) {
              throw new UnauthorizedProfileError("Unauthorized");
            }
            if (res.status !== 200) {
              throw new Error(`Profile request failed (HTTP ${res.status})`);
            }
            return (res.body ?? null) as AuthProfile | null;
          })
          .finally(() => {
            if (profileRequests.get(token) === nextRequest) {
              profileRequests.delete(token);
            }
          });
        request = nextRequest;
        profileRequests.set(token, request);
      }

      try {
        const nextProfile = await request;
        const activeToken = readAccessToken() ?? token;
        profileCache.set(activeToken, {
          value: nextProfile,
          expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
        });
        setProfile(nextProfile);
        persistLoadedProfileHints(nextProfile);

        return nextProfile;
      } catch (err) {
        if (err instanceof UnauthorizedProfileError) {
          clearStoredSessionTokens();
          setTokenState(null);
          setProfile(null);
          return null;
        }
        const message = err instanceof Error ? err.message : String(err);
        setProfileError(message);
        throw err;
      } finally {
        setProfileLoading(false);
      }
    },
    [token, offline],
  );

  // Silently upgrade legacy 30-day JWTs or proactively rotate near-expiry access tokens.
  useEffect(() => {
    if (!token || offline) {
      return;
    }
    const refreshToken = readRefreshToken();
    const needsUpgrade = !refreshToken && isLegacyAccessToken(token);
    const needsRefresh = Boolean(refreshToken) && shouldProactivelyRefresh(token);
    if (needsUpgrade || needsRefresh) {
      void refreshSessionTokens();
    }
  }, [token, offline]);

  useEffect(() => {
    if (!token || offline) {
      return;
    }

    refreshProfile().catch((err) => {
      if (!(err instanceof UnauthorizedProfileError)) {
        console.warn("Token validation failed", err);
      }
    });
  }, [token, offline, refreshProfile]);

  useEffect(() => {
    if (!token) {
      setProfile(null);
      setProfileLoading(false);
      setProfileError(null);
    }
  }, [token]);

  useEffect(() => {
    if (offline) {
      setProfileLoading(false);
    }
  }, [offline]);

  const value = useMemo(
    () => ({
      token,
      setToken,
      clearToken,
      offline,
      setOffline,
      profile,
      profileLoading,
      profileError,
      refreshProfile,
    }),
    [
      token,
      setToken,
      clearToken,
      offline,
      setOffline,
      profile,
      profileLoading,
      profileError,
      refreshProfile,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
