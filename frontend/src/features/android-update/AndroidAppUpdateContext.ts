import type { AndroidAppReleaseInfo } from "@maimai-score-hub/shared";
import { createContext, useContext } from "react";

export type AndroidAppUpdateContextValue = {
  available: boolean;
  checking: boolean;
  release: AndroidAppReleaseInfo | null;
  error: string;
  lastCheckedAt: number | null;
  updateAvailable: boolean;
  checkForUpdate(force?: boolean): Promise<void>;
};

export const AndroidAppUpdateContext =
  createContext<AndroidAppUpdateContextValue | null>(null);

export function useAndroidAppUpdate(): AndroidAppUpdateContextValue {
  const value = useContext(AndroidAppUpdateContext);
  if (!value) {
    throw new Error("AndroidAppUpdateProvider is missing");
  }
  return value;
}
