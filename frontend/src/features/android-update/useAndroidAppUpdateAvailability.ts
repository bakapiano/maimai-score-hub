import { useEffect, useState } from "react";

import {
  ANDROID_READY_EVENT,
  getAndroidAppUpdateBridge,
} from "./androidUpdateBridge";

export function useAndroidAppUpdateAvailability() {
  const [available, setAvailable] = useState(
    () => getAndroidAppUpdateBridge() !== null,
  );

  useEffect(() => {
    const detect = () => setAvailable(getAndroidAppUpdateBridge() !== null);
    detect();
    window.addEventListener(ANDROID_READY_EVENT, detect);
    return () => window.removeEventListener(ANDROID_READY_EVENT, detect);
  }, []);

  return available;
}
