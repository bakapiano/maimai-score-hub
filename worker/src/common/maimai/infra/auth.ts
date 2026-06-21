import "./request-runtime.ts";

import { CookieJar } from "tough-cookie";
import makeFetchCookie from "fetch-cookie";

import { MAIMAI_URLS, WECHAT_USER_AGENT } from "../constants.ts";
import type { GameType } from "../../types.ts";

const OAUTH_CALLBACK_HEADERS = buildWechatNavigationHeaders({
  host: "tgk-wcaime.wahlap.com",
  secFetchSite: "none",
});

const MAIMAI_HOME_HEADERS = buildWechatNavigationHeaders({
  host: "maimai.wahlap.com",
  secFetchSite: "same-origin",
});

/**
 * 获取 OAuth 认证 URL
 */
export async function getAuthUrl(type: GameType): Promise<string> {
  if (!["maimai-dx", "chunithm"].includes(type)) {
    throw new Error("unsupported type");
  }

  const res = await fetch(MAIMAI_URLS.auth(type));
  return res.url.replace("redirect_uri=https", "redirect_uri=http");
}

/**
 * 通过 OAuth 回调 URL 获取 Cookie
 */
export async function getCookieByAuthUrl(authUrl: string): Promise<CookieJar> {
  const cj = new CookieJar();
  const fetchWithCookie = makeFetchCookie(global.fetch, cj);

  await fetchWithCookie(authUrl, {
    headers: OAUTH_CALLBACK_HEADERS,
  });

  await fetchWithCookie(`${MAIMAI_URLS.home}`, {
    headers: MAIMAI_HOME_HEADERS,
  });

  return cj;
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
