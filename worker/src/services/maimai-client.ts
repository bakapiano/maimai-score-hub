/**
 * 舞萌 DX HTTP 客户端
 * 封装所有与舞萌网站的 HTTP 交互
 */

import { Agent, setGlobalDispatcher } from "undici";
import { AsyncLocalStorage } from "async_hooks";
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
 * Permanent failure inside a response assertion — should bypass retry.
 * Use for cases where retrying makes no sense, e.g. friend has not been
 * added on the cabinet so the friend_vs page will never render.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
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
  // 全局限流 —— 所有实例共享，保证相邻请求发起时间间隔 ≥ 2.5 秒以防限流
  //
  // 例外：通过 `runInBatch(fn)` 包裹的请求被视为同一个 batch，batch 内部
  //   不强制间隔（可串行 / 并发都行）。batch 结束时统一把
  //   `lastRequestStartTime` 推迟 `count * REQUEST_INTERVAL_MS`，让后续
  //   非 batch 请求等到等价的 spacing。这样既能让 send_friend_request +
  //   get_sent_requests 这种紧密耦合的两步调用快速完成，又不会突破整体
  //   速率上限。
  // =========================================================================
  /** 请求发起间最小间隔（毫秒） */
  private static readonly REQUEST_INTERVAL_MS = 5_000;
  /** 上一次请求发起的时间戳（也是 batch 计费的基准） */
  private static lastRequestStartTime = 0;
  /** 限流锁：保证等待+更新时间戳的原子性 */
  private static throttleLock: Promise<void> = Promise.resolve();
  /** 全局冻结截止时间：收到 567 后冻结所有请求 300 秒 */
  private static frozenUntil = 0;
  /** 冻结时长（毫秒） */
  private static readonly FREEZE_DURATION_MS = 60_000;

  /**
   * batch 上下文：所有在 `runInBatch` 异步范围内发出的请求会共享同一个
   * counter，互相之间不等 spacing；batch 结束后再把 spacing 一次性补回。
   */
  private static readonly batchStorage = new AsyncLocalStorage<{
    count: number;
    label?: string;
  }>();

  /**
   * 在一个 "batch" 范围内运行 fn。fn 内部所有 client 请求都被算作一个
   * 整体，batch 内不强制 REQUEST_INTERVAL_MS 间隔；batch 结束后 lastRequestStartTime
   * 会被推到 `batchStartTime + (count-1) * REQUEST_INTERVAL_MS`，下一个非 batch 请求
   * 自然要等到 `batchStartTime + count * REQUEST_INTERVAL_MS`。
   *
   * batch 不可嵌套（嵌套时内层共享外层 counter，效果等同单一 batch）。
   */
  static async runInBatch<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const existing = MaimaiHttpClient.batchStorage.getStore();
    if (existing) {
      // 已在 batch 中 — 直接复用，不开新 scope
      return fn();
    }
    const ctx = { count: 0, label };
    const batchStart = Date.now();
    try {
      return await MaimaiHttpClient.batchStorage.run(ctx, fn);
    } finally {
      // 把 spacing 一次性补回：占用 count * REQUEST_INTERVAL_MS 的"配额"。
      // 这里直接更新 lastRequestStartTime 到 batchStart + (count-1)*interval，
      // 下一个非 batch 请求的 waitForSlot 会从 lastRequestStartTime + interval
      // 开始等，等价于把整个 batch 视为 count 次串行请求消耗的时间。
      if (ctx.count > 0) {
        const charged =
          batchStart + (ctx.count - 1) * MaimaiHttpClient.REQUEST_INTERVAL_MS;
        // 不要回退（万一 batch 内部物理用时已经超过 charged）
        if (charged > MaimaiHttpClient.lastRequestStartTime) {
          MaimaiHttpClient.lastRequestStartTime = charged;
        }
        console.log(
          `[MaimaiClient] batch${label ? ` "${label}"` : ""} done: ${ctx.count} requests in ${Date.now() - batchStart}ms; throttle credit ${ctx.count * MaimaiHttpClient.REQUEST_INTERVAL_MS}ms`,
        );
      }
    }
  }

  /**
   * 触发全局冻结，所有请求将等待至冻结结束
   */
  private static freeze(): void {
    MaimaiHttpClient.frozenUntil =
      Date.now() + MaimaiHttpClient.FREEZE_DURATION_MS;
    console.log(
      `[MaimaiClient] 全局冻结 ${MaimaiHttpClient.FREEZE_DURATION_MS / 1000} 秒，所有请求将暂停`,
    );
  }

  /**
   * 等待直到距上次请求发起时间 ≥ REQUEST_INTERVAL_MS，然后标记本次发起时间
   * 同时检查全局冻结状态，若被冻结则等待至解冻
   *
   * batch 模式下：跳过 spacing wait，仅检查冻结，并把 batch counter +1。
   */
  private static async waitForSlot(): Promise<void> {
    const batch = MaimaiHttpClient.batchStorage.getStore();
    return new Promise<void>((resolve) => {
      MaimaiHttpClient.throttleLock = MaimaiHttpClient.throttleLock.then(
        async () => {
          // 检查全局冻结（batch 也要遵守，这是被服务端打回的硬指标）
          const freezeRemaining = MaimaiHttpClient.frozenUntil - Date.now();
          if (freezeRemaining > 0) {
            console.log(
              `[MaimaiClient] 请求等待全局冻结解除，剩余 ${Math.ceil(freezeRemaining / 1000)} 秒`,
            );
            await sleep(freezeRemaining);
          }

          if (batch) {
            // batch 内：不等 spacing，只记账
            batch.count++;
            resolve();
            return;
          }

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
    // Wrap the jar so we can (a) ignore Set-Cookie on 5xx responses
    // (wahlap's error-page set-cookie can clobber a valid session), and
    // (b) log every cookie write with old vs new value + originating
    // URL. fetch-cookie only touches getCookieString / setCookie on the
    // jar, so this wrapper is enough.
    //
    // Status flow: we intercept global.fetch so lastResponseStatus is
    // updated the moment a response (or redirect hop) lands. fetch-cookie
    // calls our setCookie right after, when lastResponseStatus already
    // reflects the response carrying that Set-Cookie.
    let lastResponseStatus = 0;
    const realJar = this.cookieJar;
    const wrappedJar = {
      getCookieString: (currentUrl: string) =>
        realJar.getCookieString(currentUrl),
      setCookie: async (
        cookieString: string,
        currentUrl: string,
        opts: { ignoreError: boolean },
      ) => {
        if (lastResponseStatus >= 500) {
          console.warn(
            `[MaimaiClient] Skip Set-Cookie (5xx) status=${lastResponseStatus} url=${currentUrl} setCookie=${JSON.stringify(cookieString.slice(0, 200))}`,
          );
          return;
        }
        const eq = cookieString.indexOf("=");
        const semi = cookieString.indexOf(";");
        const name = eq > 0 ? cookieString.slice(0, eq) : "<?>";
        const newValue =
          eq > 0
            ? cookieString.slice(eq + 1, semi > eq ? semi : undefined)
            : "<?>";
        let oldValue: string | undefined;
        try {
          const existing = await realJar.getCookies(currentUrl);
          oldValue = existing.find((c) => c.key === name)?.value;
        } catch {
          // Best-effort log only
        }
        if (oldValue !== newValue) {
          console.log(
            `[MaimaiClient] Set-Cookie url=${currentUrl} status=${lastResponseStatus} ${name}: ${JSON.stringify(oldValue ?? null)} → ${JSON.stringify(newValue)}`,
          );
        }
        return realJar.setCookie(cookieString, currentUrl, opts);
      },
    };
    const fetchInterceptor = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const res = await global.fetch(input, init);
      lastResponseStatus = res.status;
      return res;
    }) as typeof global.fetch;
    const fetchWithCookie = makeFetchCookie(
      fetchInterceptor,
      wrappedJar as unknown as CookieJar,
    );
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
          // Detail log so we can tell real cookie expiry from spurious
          // "expired" markers (mid-page wahlap glitches, 567 wrapped as
          // an HTML error, etc). Bot id (from URL friendCode if present)
          // is in the URL we already logged.
          const markers = [
            body.includes(COOKIE_EXPIRE_MARKERS.line1) ? 'line1' : '',
            body.includes(COOKIE_EXPIRE_MARKERS.line2) ? 'line2' : '',
            body.includes(COOKIE_EXPIRE_MARKERS.errorCode100001) ? '100001' : '',
            body.includes(COOKIE_EXPIRE_MARKERS.errorCode200002) ? '200002' : '',
          ].filter(Boolean).join(',');
          // Dump the cookie values we sent — helps see whether a stale
          // _t is what wahlap rejected (vs e.g. _t got cleared somehow).
          let cookieDump = '<unavailable>';
          try {
            cookieDump = await realJar.getCookieString(url);
          } catch {
            // ignore
          }
          console.log(
            `[MaimaiClient] CookieExpired detail url=${url} status=${result.status} location=${location} markers=[${markers}] bodyLen=${body.length} bodyHead=${JSON.stringify(body.slice(0, 400))} sentCookies=${JSON.stringify(cookieDump)}`,
          );
          throw new CookieExpiredError();
        }

        // 401/403 认证错误视为 Cookie 过期
        if (result.status === 401 || result.status === 403) {
          let cookieDump = '<unavailable>';
          try {
            cookieDump = await realJar.getCookieString(url);
          } catch {
            // ignore
          }
          console.log(
            `[MaimaiClient] CookieExpired (HTTP ${result.status}) url=${url} location=${location} bodyHead=${JSON.stringify(body.slice(0, 400))} sentCookies=${JSON.stringify(cookieDump)}`,
          );
          throw new CookieExpiredError(`Cookie 已失效 (HTTP ${result.status})`);
        }

        // 567 限流：触发全局冻结 60 秒，然后重试
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
          // 全局冻结：所有 MaimaiHttpClient 实例的请求都会等待 60 秒
          MaimaiHttpClient.freeze();
          i--; // 不消耗普通重试次数
          continue;
        }

        // 522 cloudflare "origin timed out": wahlap 已经收到 request，
        // 副作用大概率已经生效，cloudflare 只是没等到 response。对于
        // 不读 body 的写操作（friend request 系列），可以视为成功，
        // 避免在 wahlap 已经处理过的情况下又重试一次（会重复加好友 / 重复申请）。
        if (result.status === 522 && options.treat522AsSuccess) {
          console.log(
            `[MaimaiClient] 522 origin timeout treated as success url=${url}`,
          );
          return result;
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
        if (e instanceof NonRetryableError) {
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
  async getFriendList(opts?: { maxPages?: number }): Promise<FriendInfo[]> {
    console.log(`[MaimaiClient] Start get friend list`);

    // 第一页串行：要解出 friendCount 才知道总页数。
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
    const naturalTotalPages = Math.ceil(friendCount / 10) + 1;
    // 调用方可指定 maxPages（首页算第 1 页），用于 cleanup 这种不需要
    // 看到全量好友就能干活的场景，避免拖几十次请求拉满 spacing。
    const totalPages = opts?.maxPages
      ? Math.min(naturalTotalPages, Math.max(1, opts.maxPages))
      : naturalTotalPages;
    console.log(
      `[MaimaiClient] Friend count: ${friendCount}, fetching pages 2..${totalPages}${
        opts?.maxPages && totalPages < naturalTotalPages
          ? ` (capped at maxPages=${opts.maxPages}, would be ${naturalTotalPages})`
          : ''
      }`,
    );

    // 第 2-N 页串行抓，每页之间走默认 spacing。之前用 runInBatch 包
    // 起来跳过 spacing，但 batch 跨越数十秒，期间这个 bot 的其他请求
    // (e.g. send_friend_request) 会被它顶在前面无限等待。还原成默认
    // throttle 后翻页慢一点，但 bot 的其他工作不会被卡。
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
      treat522AsSuccess: true,
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
      treat522AsSuccess: true,
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
      treat522AsSuccess: true,
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
      treat522AsSuccess: true,
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
      treat522AsSuccess: true,
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
      treat522AsSuccess: true,
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
      treat522AsSuccess: true,
    });
    console.log(
      `[MaimaiClient] Done favorite off friend, friend code ${friendCode}`,
    );
  }

  /**
   * 获取 Friend VS 页面 HTML.
   *
   * `side`:
   *   undefined - default page (only songs that fit on the default
   *               cap; can miss songs in either direction)
   *   "win"     - only songs where the bot beats the friend
   *   "lose"    - only songs where the friend beats the bot
   *
   * For complete coverage we call this twice (win + lose) and merge.
   * The default-page schema is the same for all three; we just gate
   * on `friend_vs_block` presence so paginated/empty results don't
   * trigger NonRetryableError.
   */
  async getFriendVS(
    friendCode: string,
    scoreType: 1 | 2,
    diff: number,
    side?: "win" | "lose",
  ): Promise<string> {
    const startTime = Date.now();
    const url = MAIMAI_URLS.friendVS(friendCode, scoreType, diff, side);
    const result = await this.fetch(
      url,
      { headers: DEFAULT_HEADERS },
      TIMEOUTS.friendVS,
      RETRY.friendVSCount,
      RETRY.rateLimitFriendVSMaxCount,
      (body) => {
        if (!body.includes('<div class="friend_vs_block">')) {
          // Page renders fine but the friend isn't actually friends with
          // the bot — retrying won't fix this; fail fast so the job ends
          // quickly with a clear error.
          throw new NonRetryableError(
            "获取 Friend VS 页面失败：页面不包含 friend_vs_block，可能是好友没有添加成功",
          );
        }
      },
    );
    const text = await result.text();
    const cost = Date.now() - startTime;
    console.log(
      `[MaimaiClient] getFriendVS friendCode=${friendCode} scoreType=${scoreType} diff=${diff} side=${side ?? "all"} cost=${cost}ms`,
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
