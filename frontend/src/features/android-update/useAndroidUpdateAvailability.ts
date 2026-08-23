import { useEffect, useState } from "react";

import {
  ANDROID_READY_EVENT,
  getAndroidUpdateBridge,
} from "./androidUpdateBridge";

export function useAndroidUpdateAvailability() {
  const [available, setAvailable] = useState(
    () => getAndroidUpdateBridge() !== null,
  );

  useEffect(() => {
    const detect = () => setAvailable(getAndroidUpdateBridge() !== null);
    detect();
    window.addEventListener(ANDROID_READY_EVENT, detect);
    return () => window.removeEventListener(ANDROID_READY_EVENT, detect);
  }, []);

  return available;
}
