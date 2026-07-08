import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";

const {
  appContract,
  authContract,
  jobContract,
  musicContract,
  syncContract,
  usersContract,
} = sharedContract;

const withApiBase = (baseUrl = "/api/v1") => ({ baseUrl });

export const appApi = initClient(appContract as any, withApiBase()) as any;
export const authApi = initClient(authContract as any, withApiBase()) as any;
export const usersApi = initClient(usersContract as any, withApiBase()) as any;
export const syncApi = initClient(syncContract as any, withApiBase()) as any;
export const musicApi = initClient(musicContract as any, withApiBase()) as any;
export const jobApi = initClient(jobContract as any, withApiBase()) as any;

export async function getHealthStatus() {
  const res = await fetch("/api/v1/health");
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    data: text ? (JSON.parse(text) as { status?: string }) : null,
  };
}

export async function getStatistics() {
  const response = await appApi.getStatistics({});
  if (response.status !== 200) {
    throw new Error(`Unexpected status: ${response.status}`);
  }
  return response.body;
}
