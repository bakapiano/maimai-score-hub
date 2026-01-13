/**
 * Cookie 管理工具函数
 * 提供向后兼容的 cookie 操作接口
 */

import { CookieJar } from "tough-cookie";
import lodash from "lodash";

import { cookieStore } from "./state.ts";
import { MaimaiHttpClient } from "./services/maimai-client.ts";
import { WECHAT_USER_AGENT, DEFAULT_HEADERS } from "./constants.ts";
import type { MaimaiCookieValues } from "./types/index.ts";

const { throttle } = lodash;

/**
 * 加载指定 friendCode 的 CookieJar
 * @deprecated 使用 cookieStore.get() 替代
 */
export async function loadCookie(friendCode: string): Promise<CookieJar | undefined> {
  return cookieStore.get(friendCode);
}

/**
 * 保存 CookieJar
 * @deprecated 使用 cookieStore.set() 替代
 */
export async function saveCookie(cj: CookieJar, friendCode: string): Promise<void> {
  cookieStore.set(friendCode, cj);
}

/**
 * 获取 Cookie 中的关键值
 * @deprecated 使用 cookieStore.extractValues() 替代
 */
export function getCookieValue(cj: CookieJar): MaimaiCookieValues {
  return cookieStore.extractValues(cj);
}

/**
 * 测试 Cookie 是否已过期
 * 使用节流避免频繁请求
 */
export const testCookieExpired = throttle(async (cj: CookieJar): Promise<boolean> => {
  try {
    const client = new MaimaiHttpClient(cj);
    const result = await client.fetch(
      "https://maimai.wahlap.com/maimai-mobile/home/",
      { headers: DEFAULT_HEADERS },
      undefined,
      true
    );
    const body = await result.text();
    return body.indexOf("登录失败") !== -1;
  } catch (err) {
    return true;
  }
}, 5000);
