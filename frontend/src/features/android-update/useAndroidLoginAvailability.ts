import { useEffect, useState } from "react";

import {
  ANDROID_READY_EVENT,
  getAndroidLoginBridge,
} from "./androidUpdateBridge";

export function useAndroidLoginAvailability() {
  const [available, setAvailable] = useState(
    () => getAndroidLoginBridge() !== null,
  );

  useEffect(() => {
    const detect = () => setAvailable(getAndroidLoginBridge() !== null);
    window.addEventListener(ANDROID_READY_EVENT, detect);
    return () => window.removeEventListener(ANDROID_READY_EVENT, detect);
  }, []);

  return available;
}
