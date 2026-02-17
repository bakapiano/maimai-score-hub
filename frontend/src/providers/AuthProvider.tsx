import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usersApi } from "../api/appClient";

const TOKEN_KEY = "netbot_token";

type AuthContextValue = {
  token: string | null;
  setToken: (token: string | null) => void;
  clearToken: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

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

  const setToken = useCallback((next: string | null) => {
    setTokenState(next);
    persistToken(next);
  }, []);

  const clearToken = useCallback(() => setToken(null), [setToken]);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    (async () => {
      try {
        const res = await usersApi.profile({
          headers: { authorization: `Bearer ${token}` },
        });

        if (cancelled) return;

        if (res.status === 401 || res.status === 403) {
          setToken(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("Token validation failed", err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, setToken]);

  const value = useMemo(
    () => ({ token, setToken, clearToken }),
    [token, setToken, clearToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

export { TOKEN_KEY };
