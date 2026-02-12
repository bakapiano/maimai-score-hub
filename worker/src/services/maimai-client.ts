/**
 * 舞萌 DX HTTP 客户端
 * 封装所有与舞萌网站的 HTTP 交互
 */

import { Agent, setGlobalDispatcher } from "undici";
import {
  COOKIE_EXPIRE_LOCATIONS,
  COOKIE_EXPIRE_MARKERS,
  DEFAULT_HEADERS,
  MAIMAI_URLS,
  RETRY,
  TIMEOUTS,
  WECHAT_USER_AGENT,
} from "../constants.ts";
import type {
  FetchOptions,
  FriendInfo,
  GameType,
  SentFriendRequest,
  UserProfile,
} from "../types/index.ts";
import {
  parseAcceptRequests,
  parseFriendCount,
  parseFriendList,
  parseSentRequests,
  parseUserFriendCode,
  parseUserProfile,
} from "../parsers/index.ts";

import { CookieJar } from "tough-cookie";
import config from "../config.ts";
import makeFetchCookie from "fetch-cookie";
import { recordApiLog } from "../clients/job-api-log-client.ts";

/**
 * 配置全局 HTTP Keep-Alive Agent
 * 复用 TCP/TLS 连接，减少频繁建连导致的 ECONNRESET
 */
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    pipelining: 1,
    connections: 10,
  }),
);

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
export function extractContainerRedMessage(body: string): string | null {
  const match = body.match(
    /<div\s+class="container_red[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<footer|$)/i,
  );
  if (!match) return null;
  const innerHtml = match[1];
  // 去除所有 HTML 标签，保留文本内容
  const text = innerHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * 舞萌 DX HTTP 客户端类
 */
export class MaimaiHttpClient {
  private cookieJar: CookieJar;
  /** 当前关联的 jobId，用于记录 API 调用日志 */
  jobId: string | null = null;

  // =========================================================================
  // 全局限流 —— 所有实例共享，保证相邻请求发起时间间隔 ≥ 2 秒以防限流
  // =========================================================================
  /** 请求发起间最小间隔（毫秒） */
  private static readonly REQUEST_INTERVAL_MS = 2_000;
  /** 上一次请求发起的时间戳 */
  private static lastRequestStartTime = 0;
  /** 限流锁：保证等待+更新时间戳的原子性 */
  private static throttleLock: Promise<void> = Promise.resolve();

  /**
   * 等待直到距上次请求发起时间 ≥ REQUEST_INTERVAL_MS，然后标记本次发起时间
   * 请求本身不串行，仅发起时间点串行排队
   */
  private static async waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      MaimaiHttpClient.throttleLock = MaimaiHttpClient.throttleLock.then(
        async () => {
          const now = Date.now();
          const elapsed = now - MaimaiHttpClient.lastRequestStartTime;
          const waitTime = MaimaiHttpClient.REQUEST_INTERVAL_MS - elapsed;
          if (waitTime > 0) {
            await sleep(waitTime);
          }
          MaimaiHttpClient.lastRequestStartTime = Date.now();
          resolve();
        },
      );
    });
  }

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
    retryCount: number = RETRY.defaultCount,
    rateLimitMaxCount: number = RETRY.rateLimitMaxCount,
    responseAssertion?: (body: string) => void,
  ): Promise<Response> {
    const fetchWithCookie = makeFetchCookie(global.fetch, this.cookieJar);
    const fetchTimeout = timeout ?? config.fetchTimeOut ?? TIMEOUTS.default;
    let rateLimitCount = 0;

    for (let i = 0; i < retryCount; i++) {
      // 提到 try 外层，以便 finally 中记录日志时能拿到实际的 statusCode 和 responseBody
      let logStatusCode = 0;
      let logResponseBody: string | null = null;
      let logError: string | null = null;
      let shouldLog = true;

      try {
        // 等待限流间隔后再发起请求（不串行，仅控制发起时间间隔）
        await MaimaiHttpClient.waitForSlot();
        const result = await (fetchWithCookie(url, {
          signal: AbortSignal.timeout(fetchTimeout),
          ...options,
        }) as Promise<Response>);

        const location = result.url;
        const clone = result.clone();
        const body = await clone.text();

        // 保存实际的响应信息，供 finally 日志使用
        logStatusCode = result.status;
        logResponseBody = body;

        const isCookieExpireBody =
          body.includes(COOKIE_EXPIRE_MARKERS.line1) ||
          body.includes(COOKIE_EXPIRE_MARKERS.line2) ||
          body.includes(COOKIE_EXPIRE_MARKERS.errorCode100001) ||
          body.includes(COOKIE_EXPIRE_MARKERS.errorCode200002);

        if (
          COOKIE_EXPIRE_LOCATIONS.has(location as any) &&
          isCookieExpireBody
        ) {
          throw new CookieExpiredError();
        }

        // 401/403 认证错误视为 Cookie 过期
        if (result.status === 401 || result.status === 403) {
          throw new CookieExpiredError(`Cookie 已失效 (HTTP ${result.status})`);
        }

        // 567 限流：单独计算重试次数，不消耗普通重试次数
        if (result.status === 567) {
          rateLimitCount++;
          console.log(
            `[MaimaiClient] 限流 (567) ${url}, 限流重试 ${rateLimitCount}/${rateLimitMaxCount}`,
          );
          if (rateLimitCount >= rateLimitMaxCount) {
            throw new Error(
              `请求被限流 (HTTP 567)，已重试 ${rateLimitCount} 次仍未成功`,
            );
          }
          const baseDelay = Math.min(
            RETRY.rateLimitBaseDelayMs * Math.pow(2, rateLimitCount - 1),
            RETRY.rateLimitMaxDelayMs,
          );
          const jitter = Math.random() * baseDelay * 0.5;
          const delay = Math.round(baseDelay + jitter);
          console.log(`[MaimaiClient] 限流等待 ${delay}ms 后重试...`);
          await sleep(delay);
          i--; // 不消耗普通重试次数
          continue;
        }

        // 其他非成功状态码直接抛出错误，附带响应体
        if (!result.ok) {
          throw new Error(
            `请求失败 (HTTP ${result.status}): ${body.slice(0, 500)}`,
          );
        }

        const containerMsg = extractContainerRedMessage(body);
        if (containerMsg) {
          throw new Error(containerMsg);
        }

        // 调用方自定义断言（失败时抛出异常，由重试循环捕获）
        if (responseAssertion) {
          responseAssertion(body);
        }

        return result;
      } catch (e: unknown) {
        logError = e instanceof Error ? e.message : String(e);

        if (e instanceof CookieExpiredError) {
          throw e;
        }

        const error = e as Error;
        console.log(
          `Delay due to fetch failed with attempt ${url} #${
            i + 1
          }, error: ${error}`,
        );

        if (i === retryCount - 1) {
          if (error.name === "AbortError" || error.name === "TimeoutError") {
            throw new Error(`请求超时, 超时时间: ${fetchTimeout / 1000.0} 秒`);
          }
          throw e;
        }

        const baseDelay = Math.min(
          RETRY.baseDelayMs * Math.pow(2, i),
          RETRY.maxDelayMs,
        );
        const jitter = Math.random() * baseDelay * 0.5;
        const delay = Math.round(baseDelay + jitter);
        console.log(
          `Retrying in ${delay}ms (attempt ${i + 1}/${retryCount})...`,
        );
        await sleep(delay);
      } finally {
        // 统一记录 API 调用日志，能拿到实际的 statusCode 和 responseBody
        if (shouldLog && this.jobId) {
          try {
            recordApiLog(this.jobId, {
              url,
              method: options.method ?? "GET",
              statusCode: logStatusCode,
              responseBody: logError
                ? `[Error] ${logError}\n\n${logResponseBody ?? ""}`
                : logResponseBody,
            });
          } catch {
            // Best-effort logging; don't impact main request flow
          }
        }
      }
    }

    throw new Error("Unreachable");
  }

  /**
   * 带 token 的表单请求
   */
  async fetchWithToken(
    url: string,
    options: FetchOptions = {},
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

    return this.fetch(url, fetchOptions);
  }

  // =========================================================================
  // 好友相关 API
  // =========================================================================

  /**
   * 获取完整好友列表（自动翻页）
   * 第一页返回最多 10 个好友，通过好友数计算总页数后逐页获取
   */
  async getFriendList(): Promise<FriendInfo[]> {
    console.log(`[MaimaiClient] Start get friend list`);

    // 获取第一页
    const firstResult = await this.fetchWithToken(MAIMAI_URLS.friendList);
    const firstText = await firstResult.text();
    const friends = parseFriendList(firstText);
    const friendCount = parseFriendCount(firstText);

    if (friendCount === null || friendCount <= 10) {
      console.log(
        `[MaimaiClient] Done get friend list (single page), count=${friends.length}`,
      );
      return friends;
    }

    // 计算需要翻页的页数: 第 2 页到第 ceil(friendCount/10)+1 页
    const totalPages = Math.ceil(friendCount / 10) + 1;
    console.log(
      `[MaimaiClient] Friend count: ${friendCount}, fetching pages 2..${totalPages}`,
    );

    for (let page = 2; page <= totalPages; page++) {
      const pageResult = await this.fetchWithToken(
        MAIMAI_URLS.friendListPage(page),
      );
      const pageText = await pageResult.text();
      const pageFriends = parseFriendList(pageText);
      friends.push(...pageFriends);
    }

    // 去重
    const seen = new Set<string>();
    const uniqueFriends = friends.filter((f) => {
      if (seen.has(f.friendCode)) return false;
      seen.add(f.friendCode);
      return true;
    });
    console.log(
      `[MaimaiClient] Done get friend list (${totalPages} pages), count=${uniqueFriends.length}`,
    );
    return uniqueFriends;
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
      `[MaimaiClient] Start get user profile by friend code ${friendCode}`,
    );
    const url = MAIMAI_URLS.friendSearch(friendCode);
    const result = await this.fetchWithToken(url);
    const text = await result.text();
    const profile = parseUserProfile(text);
    console.log(
      `[MaimaiClient] Done get user profile by friend code ${friendCode}`,
    );
    return profile;
  }

  /**
   * 发送好友请求
   */
  async sendFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start send friend request, friend code ${friendCode}`,
    );
    await this.fetchWithToken(MAIMAI_URLS.friendSearchInvite, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}&invite=`,
      method: "POST",
      addToken: true,
    });

    await this.fetchWithToken(MAIMAI_URLS.friendInvite);
    console.log(
      `[MaimaiClient] Done send friend request, friend code ${friendCode}`,
    );
  }

  /**
   * 接受好友请求
   */
  async allowFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start allow friend request, friend code ${friendCode}`,
    );
    await this.fetchWithToken(MAIMAI_URLS.friendAcceptAllow, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}&allow=`,
      method: "POST",
      addToken: true,
    });

    await this.fetchWithToken(MAIMAI_URLS.friendAcceptAllow);
    console.log(
      `[MaimaiClient] Done allow friend request, friend code ${friendCode}`,
    );
  }

  /**
   * 拒绝好友请求
   */
  async blockFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start block friend request, friend code ${friendCode}`,
    );
    await this.fetchWithToken(MAIMAI_URLS.friendAcceptBlock, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}&block=`,
      method: "POST",
      addToken: true,
    });

    await this.fetchWithToken(MAIMAI_URLS.friendAccept);
    console.log(
      `[MaimaiClient] Done block friend request, friend code ${friendCode}`,
    );
  }

  /**
   * 取消好友请求
   */
  async cancelFriendRequest(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start cancel friend request, friend code ${friendCode}`,
    );
    await this.fetchWithToken(MAIMAI_URLS.friendInviteCancel, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}&invite=`,
      method: "POST",
      addToken: true,
    });
    console.log(
      `[MaimaiClient] Done cancel friend request, friend code ${friendCode}`,
    );
  }

  /**
   * 删除好友
   */
  async removeFriend(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start remove friend, friend code ${friendCode}`,
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
      `[MaimaiClient] Start favorite on friend, friend code ${friendCode}`,
    );
    await this.fetchWithToken(MAIMAI_URLS.friendFavoriteOn, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}`,
      method: "POST",
      addToken: true,
    });
    console.log(
      `[MaimaiClient] Done favorite on friend, friend code ${friendCode}`,
    );
  }

  /**
   * 取消收藏好友
   */
  async favoriteOffFriend(friendCode: string): Promise<void> {
    console.log(
      `[MaimaiClient] Start favorite off friend, friend code ${friendCode}`,
    );
    await this.fetchWithToken(MAIMAI_URLS.friendFavoriteOff, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `idx=${friendCode}`,
      method: "POST",
      addToken: true,
    });
    console.log(
      `[MaimaiClient] Done favorite off friend, friend code ${friendCode}`,
    );
  }

  /**
   * 获取 Friend VS 页面 HTML
   */
  async getFriendVS(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number,
  ): Promise<string> {
    const startTime = Date.now();
    const url = MAIMAI_URLS.friendVS(friendCode, scoreType, diff);
    const result = await this.fetch(
      url,
      { headers: DEFAULT_HEADERS },
      TIMEOUTS.friendVS,
      RETRY.friendVSCount,
      RETRY.rateLimitFriendVSMaxCount,
      (body) => {
        if (!body.includes('<div class="friend_vs_block">')) {
          throw new Error(
            "获取 Friend VS 页面失败：页面不包含 friend_vs_block，可能是好友没有添加成功",
          );
        }
      },
    );
    const text = await result.text();
    const cost = Date.now() - startTime;
    console.log(
      `[MaimaiClient] getFriendVS friendCode=${friendCode} scoreType=${scoreType} diff=${diff} cost=${cost}ms`,
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
      // Connection: "keep-alive",
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
