import {
  AndroidAppReleaseLatestResponseSchema,
  type AndroidAppReleaseLatestResponse,
} from "@maimai-score-hub/shared";

import { apiUrl } from "../../api/baseUrl";
import type { AndroidAppUpdateBridge } from "./androidUpdateBridge";

const INSTALLATION_ID_KEY = "msh_android_installation_id";

export async function getLatestAndroidAppRelease(
  bridge: AndroidAppUpdateBridge,
): Promise<AndroidAppReleaseLatestResponse> {
  const query = new URLSearchParams({
    channel: bridge.getReleaseChannel(),
    packageName: bridge.getPackageName(),
    currentVersionCode: String(bridge.getVersionCode()),
    installationId: getInstallationId(),
  });
  const response = await fetch(
    apiUrl(`/android/app/releases/latest?${query.toString()}`),
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`检查应用更新失败（HTTP ${response.status}）`);
  }
  return AndroidAppReleaseLatestResponseSchema.parse(await response.json());
}

function getInstallationId(): string {
  const existing = localStorage.getItem(INSTALLATION_ID_KEY);
  if (existing && /^[A-Za-z0-9._-]{8,128}$/.test(existing)) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(INSTALLATION_ID_KEY, created);
  return created;
}
