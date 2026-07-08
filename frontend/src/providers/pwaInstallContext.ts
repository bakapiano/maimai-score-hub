import { createContext } from "react";

export type InstallOutcome = "accepted" | "dismissed";
export type InstallStatus = "prompt" | "ios" | "installed" | "unavailable";

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: InstallOutcome; platform: string }>;
};

export type PwaInstallContextValue = {
  status: InstallStatus;
  install: () => Promise<InstallOutcome | "unavailable" | "error">;
};

export const PwaInstallContext =
  createContext<PwaInstallContextValue | null>(null);

export function isStandalone() {
  if (typeof window === "undefined") {return false;}
  if (window.matchMedia("(display-mode: standalone)").matches) {return true;}

  const navigatorWithStandalone = navigator as Navigator & {
    standalone?: boolean;
  };
  return navigatorWithStandalone.standalone === true;
}

export function isIos() {
  if (typeof navigator === "undefined") {return false;}
  const userAgent = navigator.userAgent.toLowerCase();
  return (
    /iphone|ipad|ipod/.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
