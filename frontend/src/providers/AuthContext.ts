import { createContext, useContext } from "react";

import type { UserProfile } from "../components/ProfileCard";

export type AuthProfile = {
  id: string;
  friendCode: string;
  username?: string | null;
  hasPassword?: boolean;
  hasDivingFishImportToken?: boolean;
  hasLxnsImportToken?: boolean;
  profile?: UserProfile | null;
  hasCabinetUserId?: boolean;
  autoUpdate?: boolean;
  lastScoreHash?: string | null;
};

export type RefreshProfileOptions = {
  force?: boolean;
};

export type AuthContextValue = {
  token: string | null;
  setToken: (token: string | null) => void;
  clearToken: () => void;
  offline: boolean;
  setOffline: (v: boolean) => void;
  profile: AuthProfile | null;
  profileLoading: boolean;
  profileError: string | null;
  refreshProfile: (
    options?: RefreshProfileOptions,
  ) => Promise<AuthProfile | null>;
};

export const AuthContext = createContext<AuthContextValue | undefined>(
  undefined,
);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
