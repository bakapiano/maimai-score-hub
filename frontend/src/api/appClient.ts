import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";
import type { AppStatistics } from "@maimai-score-hub/shared";
import { API_BASE_URL, apiUrl } from "./baseUrl";

const {
  appContract,
  authContract,
  jobContract,
  musicContract,
  syncContract,
  usersContract,
} = sharedContract;

const withApiBase = (baseUrl = API_BASE_URL) => ({ baseUrl });

export const appApi = initClient(appContract as any, withApiBase()) as any;
export const authApi = initClient(authContract as any, withApiBase()) as any;
export const usersApi = initClient(usersContract as any, withApiBase()) as any;
export const syncApi = initClient(syncContract as any, withApiBase()) as any;
export const musicApi = initClient(musicContract as any, withApiBase()) as any;
export const jobApi = initClient(jobContract as any, withApiBase()) as any;

export async function getHealthStatus() {
  const res = await fetch(apiUrl("/health"));
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    data: text ? (JSON.parse(text) as { status?: string }) : null,
  };
}

export async function getStatistics(): Promise<AppStatistics> {
  const response = await appApi.getStatistics({});
  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }
  return response.body as AppStatistics;
}
