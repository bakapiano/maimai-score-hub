import type { AndroidAppReleaseInfo } from "@maimai-score-hub/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getLatestAndroidAppRelease } from "./androidAppReleaseClient";
import {
  AndroidAppUpdateContext,
  type AndroidAppUpdateContextValue,
} from "./AndroidAppUpdateContext";
import {
  ANDROID_READY_EVENT,
  getAndroidAppUpdateBridge,
} from "./androidUpdateBridge";

const FOREGROUND_RECHECK_INTERVAL_MS = 30 * 60_000;

type AndroidAppUpdateState = {
  available: boolean;
  checking: boolean;
  release: AndroidAppReleaseInfo | null;
  error: string;
  lastCheckedAt: number | null;
};

export function AndroidAppUpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AndroidAppUpdateState>(() => ({
    available: getAndroidAppUpdateBridge() !== null,
    checking: false,
    release: null,
    error: "",
    lastCheckedAt: null,
  }));
  const lastAttemptAtRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const checkForUpdate = useCallback(async (force = false) => {
    const bridge = getAndroidAppUpdateBridge();
    if (!bridge) {
      setState((current) => ({
        ...current,
        available: false,
        checking: false,
        release: null,
        error: "",
      }));
      return;
    }

    setState((current) => ({ ...current, available: true }));
    const now = Date.now();
    if (
      !force &&
      lastAttemptAtRef.current > 0 &&
      now - lastAttemptAtRef.current < FOREGROUND_RECHECK_INTERVAL_MS
    ) {
      return;
    }
    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    lastAttemptAtRef.current = now;
    const operation = (async () => {
      setState((current) => ({ ...current, checking: true, error: "" }));
      try {
        const result = await getLatestAndroidAppRelease(bridge);
        setState((current) => ({
          ...current,
          available: true,
          release: result.updateAvailable ? result.release : null,
          error: "",
          lastCheckedAt: Date.now(),
        }));
      } catch (value) {
        setState((current) => ({
          ...current,
          available: true,
          error: value instanceof Error ? value.message : String(value),
        }));
      } finally {
        setState((current) => ({ ...current, checking: false }));
      }
    })();
    inFlightRef.current = operation;
    try {
      await operation;
    } finally {
      if (inFlightRef.current === operation) {
        inFlightRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const checkInBackground = () => void checkForUpdate();
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") {
        checkInBackground();
      }
    };

    checkInBackground();
    window.addEventListener(ANDROID_READY_EVENT, checkInBackground);
    window.addEventListener("pageshow", checkInBackground);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.removeEventListener(ANDROID_READY_EVENT, checkInBackground);
      window.removeEventListener("pageshow", checkInBackground);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [checkForUpdate]);

  const value = useMemo<AndroidAppUpdateContextValue>(
    () => ({
      ...state,
      updateAvailable: state.release !== null,
      checkForUpdate,
    }),
    [checkForUpdate, state],
  );

  return (
    <AndroidAppUpdateContext.Provider value={value}>
      {children}
    </AndroidAppUpdateContext.Provider>
  );
}
