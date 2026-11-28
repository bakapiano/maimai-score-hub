import {
  initClient,
  tsRestFetchApi,
  type ApiFetcher,
} from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";
import type { AppStatistics } from "@maimai-score-hub/shared";
import { API_BASE_URL, apiUrl } from "./baseUrl";
import { CDN_BASE_URL } from "./cdnUrl";
import { refreshSessionTokens } from "../utils/authSession";

const {
  appContract,
  authContract,
  jobContract,
  musicContract,
  syncContract,
  usersContract,
} = sharedContract;

const authedTsRestApi: ApiFetcher = async (args) => {
  const response = await tsRestFetchApi(args);
  const authHeader =
    args.headers?.authorization ?? args.headers?.Authorization;
  if (
    response.status === 401 &&
    typeof authHeader === "string" &&
    authHeader.toLowerCase().startsWith("bearer ") &&
    !args.path.includes("/auth/refresh") &&
    !args.path.includes("/auth/upgrade") &&
    !args.path.includes("/auth/logout")
  ) {
    const nextToken = await refreshSessionTokens();
    if (nextToken) {
      return tsRestFetchApi({
        ...args,
        headers: {
          ...args.headers,
          authorization: `Bearer ${nextToken}`,
        },
      });
    }
  }
  return response;
};

const withApiBase = (baseUrl = API_BASE_URL) => ({
  baseUrl,
  api: authedTsRestApi,
});

const MUSIC_API_BASE_URL = CDN_BASE_URL
  ? `${CDN_BASE_URL}/api/v1`
  : API_BASE_URL;

export const appApi = initClient(appContract as any, withApiBase()) as any;
export const authApi = initClient(authContract as any, withApiBase()) as any;
export const usersApi = initClient(usersContract as any, withApiBase()) as any;
export const syncApi = initClient(syncContract as any, withApiBase()) as any;
export const musicApi = initClient(
  musicContract as any,
  withApiBase(MUSIC_API_BASE_URL),
) as any;
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
