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
  type RefreshProfileOptions,
} from "./AuthContext";
import {
  isOfflineMode,
  cacheProfile,
  setOfflineMode as persistOfflineMode,
} from "../utils/offlineCache";

const TOKEN_KEY = "netbot_token";
const PROFILE_CACHE_TTL_MS = 10_000;

const profileRequests = new Map<string, Promise<AuthProfile | null>>();
const profileCache = new Map<
  string,
  { value: AuthProfile | null; expiresAt: number }
>();

class UnauthorizedProfileError extends Error {}

function readInitialToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (err) {
    console.warn("Cannot read token from localStorage", err);
    return null;
  }
}

function persistToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch (err) {
    console.warn("Cannot persist token to localStorage", err);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() =>
    readInitialToken()
  );
  const [offline, setOfflineState] = useState(() => isOfflineMode());
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const setToken = useCallback((next: string | null) => {
    setProfile(null);
    setProfileError(null);
    setTokenState(next);
    persistToken(next);
  }, []);

  const clearToken = useCallback(() => setToken(null), [setToken]);

  const setOffline = useCallback((v: boolean) => {
    setOfflineState(v);
    persistOfflineMode(v);
  }, []);

  const refreshProfile = useCallback(
    async (options: RefreshProfileOptions = {}) => {
      if (!token || offline) {
        setProfileLoading(false);
        if (!token) {setProfile(null);}
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
        profileCache.set(token, {
          value: nextProfile,
          expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
        });
        setProfile(nextProfile);

        const fc = nextProfile?.friendCode;
        const username = nextProfile?.username;
        try {
          if (fc) {localStorage.setItem("lastFriendCode", fc);}
          if (username) {localStorage.setItem("lastUsername", username);}
        } catch {
          // ignore
        }
        if (nextProfile?.profile) {
          cacheProfile({
            avatarUrl: nextProfile.profile.avatarUrl,
            username: nextProfile.profile.username,
            friendCode: nextProfile.friendCode,
          });
        }

        return nextProfile;
      } catch (err) {
        if (err instanceof UnauthorizedProfileError) {
          setToken(null);
          return null;
        }
        const message = err instanceof Error ? err.message : String(err);
        setProfileError(message);
        throw err;
      } finally {
        setProfileLoading(false);
      }
    },
    [token, offline, setToken],
  );

  useEffect(() => {
    // Skip token validation in offline mode
    if (!token || offline) {return;}

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
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
