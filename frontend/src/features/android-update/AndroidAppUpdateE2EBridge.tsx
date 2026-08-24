import { useEffect } from "react";

import { startAndroidAppUpdate } from "./androidUpdateBridge";

declare global {
  interface Window {
    __mshStartAndroidAppUpdateE2E?: (releaseId: string) => void;
  }
}

export function AndroidAppUpdateE2EBridge() {
  useEffect(() => {
    window.__mshStartAndroidAppUpdateE2E = (releaseId: string) => {
      void startAndroidAppUpdate(releaseId, (status) => {
        console.info("[MaiScoreHubAppUpdate]", JSON.stringify(status));
      }).catch((value: unknown) => {
        console.info(
          "[MaiScoreHubAppUpdate]",
          JSON.stringify({
            terminal: true,
            success: false,
            message: value instanceof Error ? value.message : String(value),
          }),
        );
      });
    };
    return () => {
      delete window.__mshStartAndroidAppUpdateE2E;
    };
  }, []);

  return null;
}
