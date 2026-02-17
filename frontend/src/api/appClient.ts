import { initClient } from '@ts-rest/core';
import * as sharedContract from '@maimai-score-hub/shared';

const {
  adminContract,
  authContract,
  coverContract,
  jobContract,
  musicContract,
  syncContract,
  usersContract,
} = sharedContract;

const withApiBase = (baseUrl = '/api') => ({ baseUrl });

export const authApi = initClient(authContract, withApiBase());
export const usersApi = initClient(usersContract, withApiBase());
export const syncApi = initClient(syncContract, withApiBase());
export const musicApi = initClient(musicContract, withApiBase());
export const adminApi = initClient(adminContract, withApiBase());
export const coverApi = initClient(coverContract, withApiBase());
export const jobApi = initClient(jobContract, withApiBase());

export async function getHealthStatus() {
  const res = await fetch('/api/health');
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    data: text ? (JSON.parse(text) as { status?: string }) : null,
  };
}
