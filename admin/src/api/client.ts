/* eslint-disable @typescript-eslint/no-explicit-any */
import { initClient } from "@ts-rest/core";
import { adminContract, coverContract } from "@maimai-score-hub/shared";

import type { AdminEnvironment } from "../utils/admin";

export const DEV_API_BASE_URL = (
  import.meta.env.VITE_DEV_API_BASE_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  "/api/v1"
).replace(/\/+$/, "");

export const PROD_API_BASE_URL = (
  import.meta.env.VITE_PROD_API_BASE_URL ||
  "https://api.maiscorehub.bakapiano.com/api/v1"
).replace(/\/+$/, "");

export function getApiBaseUrl(environment: AdminEnvironment) {
  return environment === "prod" ? PROD_API_BASE_URL : DEV_API_BASE_URL;
}

const withApiBase = (environment: AdminEnvironment) => ({
  baseUrl: getApiBaseUrl(environment),
});

export function createAdminApi(environment: AdminEnvironment) {
  return initClient(adminContract as any, withApiBase(environment)) as any;
}

export function createCoverApi(environment: AdminEnvironment) {
  return initClient(coverContract as any, withApiBase(environment)) as any;
}

export function adminHeaders(secret: string) {
  return { "x-api-secret": secret };
}

export function buildApiUrl(
  environment: AdminEnvironment,
  path: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) {
  const apiBaseUrl = getApiBaseUrl(environment);
  const base = apiBaseUrl.startsWith("http")
    ? apiBaseUrl
    : `${window.location.origin}${apiBaseUrl}`;
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function adminFetch<T>(
  environment: AdminEnvironment,
  path: string,
  secret: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) {
  const res = await fetch(buildApiUrl(environment, path, params), {
    headers: adminHeaders(secret),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
