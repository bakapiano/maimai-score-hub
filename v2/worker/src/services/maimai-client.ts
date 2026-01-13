/**
 * 舞萌 DX HTTP 客户端
 * 封装所有与舞萌网站的 HTTP 交互
 */

import { CookieJar } from "tough-cookie";
import makeFetchCookie from "fetch-cookie";
import config from "../config.ts";
import {
  WECHAT_USER_AGENT,
  DEFAULT_HEADERS,
  MAIMAI_URLS,
  COOKIE_EXPIRE_LOCATIONS,
  COOKIE_EXPIRE_MARKERS,
  TIMEOUTS,
  RETRY,
} from "../constants.ts";
import type {
  GameType,
  FetchOptions,
  UserProfile,
  SentFriendRequest,
} from "../types/index.ts";
import {
  parseUserProfile,
  parseFriendList,
  parseSentRequests,
  parseAcceptRequests,
  parseUserFriendCode,
} from "../parsers/index.ts";

/**
 * Cookie 已过期错误
 */
export class CookieExpiredError extends Error {
  constructor(message = "Cookie 已失效") {
    super(message);
    this.name = "CookieExpiredError";
  }
}

/**
 * 从 HTML 中提取 container_red 错误信息
 */
function extractContainerRedMessage(body: string): string | null {
  const match = body.match(
    /<div\s+class="container_red p_10"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (!match) return null;
  const innerHtml = match[1];
  const text = innerHtml.replace(/<[^>]*>/g, "").trim();
  return text || null;
}

/**
 * 舞萌 DX HTTP 客户端类
 */
export class MaimaiHttpClient {
  private cookieJar: CookieJar;

  constructor(cookieJar: CookieJar) {
    this.cookieJar = cookieJar;
  }

  /**
   * 获取 CookieJar
   */
  getCookieJar(): CookieJar {
    return this.cookieJar;
  }

  /**
   * 获取 token 用于表单提交
   */
  private getToken(): string | undefined {
    const cookies = this.cookieJar.getCookiesSync("https://maimai.wahlap.com");
    return cookies.find((c) => c.key === "_t")?.value;
  }

  /**
   * 带重试的请求方法
   */
  async fetch(
    url: string,
    options: FetchOptions = {},
    timeout?: number,
    throwOnCookieExpire = false
  ): Promise<Response> {
    const fetchWithCookie = makeFetchCookie(global.fetch, this.cookieJar);
    const retryCount = config.fetchRetryCount ?? RETRY.defaultCount;
    const fetchTimeout = timeout ?? config.fetchTimeOut ?? TIMEOUTS.default;

    for (let i = 0; i < retryCount; i++) {
      try {
        const result = (await fetchWithCookie(url, {
          signal: AbortSignal.timeout(fetchTimeout),
          ...options,
        })) as Response;

        if (throwOnCookieExpire) {
          const location = result.url;
          const clone = result.clone();
          const body = await clone.text();

          const isCookieExpireBody =
            body.includes(COOKIE_EXPIRE_MARKERS.line1) &&
            body.includes(COOKIE_EXPIRE_MARKERS.line2);

          if (
            COOKIE_EXPIRE_LOCATIONS.has(location as any) &&
            isCookieExpireBody
          ) {
            throw new CookieExpiredError();
          }

          const containerMsg = extractContainerRedMessage(body);
          if (containerMsg) {
            throw new Error(containerMsg);
          }
        }

        return result;
      } catch (e: unknown) {
        if (e instanceof CookieExpiredError) {
          throw e;
        }

        const error = e as Error;
        console.log(
          `Delay due to fetch failed with attempt ${url} #${
            i + 1
          }, error: ${error}`
        );

        if (i === retryCount - 1) {
          if (error.name === "AbortError" || error.name === "TimeoutError") {
            throw new Error(`请求超时, 超时时间: ${fetchTimeout / 1000.0} 秒`);
          }
          throw e;
        }

        await sleep(RETRY.delayMs);
      }
    }

    throw new Error("Unreachable");
  }

  /**
   * 带 token 的表单请求
   */
  async fetchWithToken(
    url: string,
    options: FetchOptions = {}
  ): Promise<Response> {
    let fetchOptions = { ...options };

    if (fetchOptions.addToken) {
      const token = this.getToken();
      delete fetchOptions.addToken;
      fetchOptions = {
        ...fetchOptions,
        body: `${fetchOptions.body}&token=${token}`,
      };
    }

    fetchOptions = {
      ...fetchOptions,
      headers: {
        ...DEFAULT_HEADERS,
        ...fetchOptions.headers,
      },
    };

    return this.fetch(url, fetchOptions, undefined, true);
  }

  // =========================================================================
  // 好友相关 API
  // =========================================================================

  /**
   * 获取好友列表
   */
  async getFriendList(): Promise<string[]> {
    console.log(`[MaimaiClient] Start get friend list`);
    const result = await this.fetchWithToken(MAIMAI_URLS.friendList);
    const text = await result.text();
    const ids = parseFriendList(text);
    console.log(`[MaimaiClient] Done get friend list`);
    return ids;
  }

  /**
   * 获取已发送的好友请求
   */
  async getSentRequests(): Promise<SentFriendRequest[]> {
    console.log(`[MaimaiClient] Start get sent friend requests`);
    const result = await this.fetchWithToken(MAIMAI_URLS.friendInvite);
    const text = await result.text();
    const requests = parseSentRequests(text);
    console.log(`[MaimaiClient] Done get sent friend requests`);
    return requests;
  }

  /**
   * 获取待接受的好友请求
   */
  async getAcceptRequests(): Promise<string[]> {
    console.log(`[MaimaiClient] Start get accept friend requests`);
    const result = await this.fetchWithToken(MAIMAI_URLS.friendAccept);
    const text = await result.text();
    const ids = parseAcceptRequests(text);
    console.log(`[MaimaiClient] Done get accept friend requests:`, ids);
    return ids;
  }

  /**
   * 根据好友代码获取用户资料
   */
  async getUserProfile(friendCode: string): Promise<UserProfile | null> {
    console.log(
      `[MaimaiClient] Start get user profile by friend code ${friendCode}`
    );
    const url = MAIMAI_URLS.friendSearch(friendCode);
    const result = await this.fetchWithToken(url);
    const text = await result.text();
    const profile = parseUserProfile(text);
    console.log(
      `[MaimaiClient] Done get user profile by friend code ${friendCode}`
    );
    return profile;
  }

  /**
   * 发送好友请求
   */
  async sendFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start send friend request, friend code ${friendCode}`
    );
    await this.fetchWithToken(MAIMAI_URLS.friendSearchInvite, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}&invite=`,
      method: "POST",
      addToken: true,
    });

    await this.fetchWithToken(MAIMAI_URLS.friendInvite);
    console.log(
      `[MaimaiClient] Done send friend request, friend code ${friendCode}`
    );
  }

  /**
   * 接受好友请求
   */
  async allowFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start allow friend request, friend code ${friendCode}`
    );
    await this.fetchWithToken(MAIMAI_URLS.friendAcceptAllow, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}&allow=`,
      method: "POST",
      addToken: true,
    });

    await this.fetchWithToken(MAIMAI_URLS.friendAcceptAllow);
    console.log(
      `[MaimaiClient] Done allow friend request, friend code ${friendCode}`
    );
  }

  /**
   * 取消好友请求
   */
  async cancelFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start cancel friend request, friend code ${friendCode}`
    );
    await this.fetchWithToken(MAIMAI_URLS.friendInviteCancel, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}&invite=`,
      method: "POST",
      addToken: true,
    });
    console.log(
      `[MaimaiClient] Done cancel friend request, friend code ${friendCode}`
    );
  }

  /**
   * 删除好友
   */
  async removeFriend(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start remove friend, friend code ${friendCode}`
    );
    await this.fetchWithToken(MAIMAI_URLS.friendDetail, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}`,
      method: "POST",
      addToken: true,
    });
    console.log(`[MaimaiClient] Done remove friend, friend code ${friendCode}`);
  }

  /**
   * 收藏好友
   */
  async favoriteOnFriend(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start favorite on friend, friend code ${friendCode}`
    );
    await this.fetchWithToken(MAIMAI_URLS.friendFavoriteOn, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}`,
      method: "POST",
      addToken: true,
    });
    console.log(
      `[MaimaiClient] Done favorite on friend, friend code ${friendCode}`
    );
  }

  /**
   * 获取 Friend VS 页面 HTML
   */
  async getFriendVS(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number
  ): Promise<string> {
    const startTime = Date.now();
    const url = MAIMAI_URLS.friendVS(friendCode, scoreType, diff);
    const result = await this.fetch(
      url,
      { headers: DEFAULT_HEADERS },
      TIMEOUTS.friendVS,
      true
    );
    const text = await result.text();
    const cost = Date.now() - startTime;
    console.log(
      `[MaimaiClient] getFriendVS friendCode=${friendCode} scoreType=${scoreType} diff=${diff} cost=${cost}ms`
    );
    return text;
  }

  /**
   * 获取当前用户的好友代码
   */
  async getUserFriendCode(): Promise<string | null> {
    console.log(`[MaimaiClient] Start get user friend code`);
    const result = await this.fetchWithToken(MAIMAI_URLS.userFriendCode);
    const text = await result.text();
    const friendCode = parseUserFriendCode(text);
    console.log(`[MaimaiClient] Done get user friend code: ${friendCode}`);
    return friendCode;
  }
}

// =========================================================================
// 认证相关（静态方法）
// =========================================================================

/**
 * 获取 OAuth 认证 URL
 */
export async function getAuthUrl(type: GameType): Promise<string> {
  if (!["maimai-dx", "chunithm"].includes(type)) {
    throw new Error("unsupported type");
  }

  const res = await fetch(MAIMAI_URLS.auth(type));
  const href = res.url.replace("redirect_uri=https", "redirect_uri=http");
  return href;
}

/**
 * 通过 OAuth 回调 URL 获取 Cookie
 */
export async function getCookieByAuthUrl(authUrl: string): Promise<CookieJar> {
  const cj = new CookieJar();
  const fetchWithCookie = makeFetchCookie(global.fetch, cj);

  await fetchWithCookie(authUrl, {
    headers: {
      Host: "tgk-wcaime.wahlap.com",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": WECHAT_USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  await fetchWithCookie(`${MAIMAI_URLS.home}`);

  return cj;
}

// =========================================================================
// 工具函数
// =========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sleep };
