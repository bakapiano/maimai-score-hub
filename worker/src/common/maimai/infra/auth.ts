import "./request-runtime.ts";

import { CookieJar } from "tough-cookie";
import makeFetchCookie from "fetch-cookie";
import {
  reportWorkerExternalApiCalls,
  type ApiCallPayload,
} from "../../backend/api-calls.ts";

import { MAIMAI_URLS, WECHAT_USER_AGENT } from "../constants.ts";
import type { GameType } from "../../types.ts";

/**
 * 获取 OAuth 认证 URL
 */
export async function getAuthUrl(type: GameType): Promise<string> {
  if (!["maimai-dx", "chunithm"].includes(type)) {
    throw new Error("unsupported type");
  }

  const startedAt = Date.now();
  const res = await fetch(MAIMAI_URLS.auth(type));
  void reportMaimaiAuthCall({
    urlGroup: "maimai.oauth.authorize",
    method: "GET",
    statusCode: res.status,
    durationMs: Date.now() - startedAt,
  });
  return res.url.replace("redirect_uri=https", "redirect_uri=http");
}

/**
 * 通过 OAuth 回调 URL 获取 Cookie
 */
export async function getCookieByAuthUrl(
  authUrl: string,
  clientHeaders: Readonly<
    Record<string, string | readonly string[] | undefined>
  > = {},
): Promise<CookieJar> {
  const cj = new CookieJar();
  const fetchWithCookie = makeFetchCookie(global.fetch, cj);

  const callbackHeaders = buildWechatNavigationHeaders({
    host: "tgk-wcaime.wahlap.com",
    secFetchSite: "none",
  });
  applyClientNavigationHeaders(callbackHeaders, clientHeaders, true);

  const homeHeaders = buildWechatNavigationHeaders({
    host: "maimai.wahlap.com",
    secFetchSite: "same-origin",
  });
  applyClientNavigationHeaders(homeHeaders, clientHeaders, false);

  let startedAt = Date.now();
  const authResponse = await fetchWithCookie(authUrl, {
    headers: callbackHeaders,
  });
  await logOAuthResponse("callback", authResponse, cj);
  void reportMaimaiAuthCall({
    urlGroup: "maimai.oauth.callback",
    method: "GET",
    statusCode: authResponse.status,
    durationMs: Date.now() - startedAt,
  });

  startedAt = Date.now();
  const homeResponse = await fetchWithCookie(`${MAIMAI_URLS.home}`, {
    headers: homeHeaders,
  });
  await logOAuthResponse("home", homeResponse, cj);
  void reportMaimaiAuthCall({
    urlGroup: "maimai.home",
    method: "GET",
    statusCode: homeResponse.status,
    durationMs: Date.now() - startedAt,
  });

  return cj;
}

function applyClientNavigationHeaders(
  target: Record<string, string>,
  source: Readonly<
    Record<string, string | readonly string[] | undefined>
  >,
  includeCrossSiteHeaders: boolean,
): void {
  const commonHeaders = [
    ["user-agent", "User-Agent"],
    ["accept", "Accept"],
    ["accept-encoding", "Accept-Encoding"],
    ["accept-language", "Accept-Language"],
    ["upgrade-insecure-requests", "Upgrade-Insecure-Requests"],
  ] as const;
  const crossSiteHeaders = [
    ["referer", "Referer"],
    ["sec-fetch-site", "Sec-Fetch-Site"],
    ["sec-fetch-mode", "Sec-Fetch-Mode"],
    ["sec-fetch-user", "Sec-Fetch-User"],
    ["sec-fetch-dest", "Sec-Fetch-Dest"],
  ] as const;

  for (const [sourceName, targetName] of [
    ...commonHeaders,
    ...(includeCrossSiteHeaders ? crossSiteHeaders : []),
  ]) {
    const value = getSafeClientHeader(source, sourceName);
    if (value) target[targetName] = value;
  }
}

function getSafeClientHeader(
  headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >,
  name: string,
): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw.join(", ") : raw;
  if (typeof value !== "string" || !value || value.length > 4096) {
    return undefined;
  }
  if (/[\r\n]/.test(value)) return undefined;
  return value;
}

async function logOAuthResponse(
  step: string,
  response: Response,
  cookieJar: CookieJar,
): Promise<void> {
  const finalUrl = new URL(response.url);
  const cookieNames = (
    await cookieJar.getCookies(`${finalUrl.origin}${finalUrl.pathname}`)
  )
    .map((cookie) => cookie.key)
    .sort();
  console.log(
    `[OAuth] ${step} status=${response.status} final=${finalUrl.origin}${finalUrl.pathname} cookies=[${cookieNames.join(",")}]`,
  );
}

function reportMaimaiAuthCall(input: {
  urlGroup: string;
  method: string;
  statusCode: number;
  durationMs: number;
}): Promise<void> {
  const call: ApiCallPayload = {
    ts: new Date().toISOString(),
    target: "maimai_dxnet",
    apiGroup: "maimai.auth",
    method: input.method,
    urlGroup: input.urlGroup,
    statusCode: input.statusCode,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    bodySize: null,
    errorClass: input.statusCode >= 400 ? "http_error" : undefined,
    workerKind: "dxnet",
    workerId:
      process.env.WORKER_ID || `dxnet-worker-${process.env.HOSTNAME || "unknown"}`,
    botFriendCode: "",
  };
  return reportWorkerExternalApiCalls("dxnet", [call]);
}

function buildWechatNavigationHeaders({
  host,
  secFetchSite,
}: {
  host: string;
  secFetchSite: "none" | "same-origin";
}): Record<string, string> {
  return {
    Host: host,
    "User-Agent": WECHAT_USER_AGENT,
    "Upgrade-Insecure-Requests": "1",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "Sec-Fetch-Site": secFetchSite,
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-User": "?1",
    "Sec-Fetch-Dest": "document",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  };
}
