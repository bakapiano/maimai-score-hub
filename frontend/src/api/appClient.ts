import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";

const {
  adminContract,
  authContract,
  coverContract,
  jobContract,
  musicContract,
  syncContract,
  usersContract,
} = sharedContract;

const withApiBase = (baseUrl = "/api/v1") => ({ baseUrl });

export const authApi = initClient(authContract as any, withApiBase()) as any;
export const usersApi = initClient(usersContract as any, withApiBase()) as any;
export const syncApi = initClient(syncContract as any, withApiBase()) as any;
export const musicApi = initClient(musicContract as any, withApiBase()) as any;
export const adminApi = initClient(adminContract as any, withApiBase()) as any;
export const coverApi = initClient(coverContract as any, withApiBase()) as any;
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
