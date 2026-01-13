/**
 * Cookie 存储管理模块
 * 封装 CookieJar 的存储和访问逻辑
 */

import { CookieJar } from "tough-cookie";
import type { MaimaiCookieValues } from "../types/index.ts";

/**
 * Cookie 存储类
 * 管理多个 Bot 账号的 CookieJar
 */
export class CookieStore {
  private cookieJars = new Map<string, CookieJar>();

  /**
   * 获取指定 friendCode 的 CookieJar
   */
  get(friendCode: string): CookieJar | undefined {
    return this.cookieJars.get(friendCode);
  }

  /**
   * 存储 CookieJar
   * @param friendCode Bot 的好友代码
   * @param jar CookieJar 实例
   */
  set(friendCode: string, jar: CookieJar): void {
    // Set cookie expire day to 2099, or will lose this value when save cookie to file
    // This may be a bug(or by design) for CookieJar from node-fetch-cookies
    this.extendCookieExpiry(jar);
    this.cookieJars.set(friendCode, jar);
  }

  /**
   * 删除指定 friendCode 的 CookieJar
   */
  delete(friendCode: string): boolean {
    return this.cookieJars.delete(friendCode);
  }

  /**
   * 检查是否存在指定 friendCode 的 CookieJar
   */
  has(friendCode: string): boolean {
    return this.cookieJars.has(friendCode);
  }

  /**
   * 获取所有已注册的 Bot friendCode 列表
   */
  getAllBotFriendCodes(): string[] {
    return Array.from(this.cookieJars.keys());
  }

  /**
   * 获取可用 Bot 数量
   */
  get size(): number {
    return this.cookieJars.size;
  }

  /**
   * 清空所有 CookieJar
   */
  clear(): void {
    this.cookieJars.clear();
  }

  /**
   * 提取 CookieJar 中的关键 cookie 值
   */
  extractValues(jar: CookieJar): MaimaiCookieValues {
    const cookies = (jar as any).cookies?.get("maimai.wahlap.com");
    return {
      _t: cookies?.get("_t")?.value,
      userId: cookies?.get("userId")?.value,
      friendCodeList: cookies?.get("friendCodeList")?.value,
    };
  }

  /**
   * 延长 cookie 过期时间到 2099 年
   * 防止 CookieJar 序列化时丢失 cookie
   */
  private extendCookieExpiry(jar: CookieJar): void {
    const cookies = (jar as any).cookies?.get("maimai.wahlap.com");
    if (!cookies) return;

    for (const [key] of cookies) {
      const cookie = cookies.get(key);
      if (cookie) {
        cookie.expiry = new Date().setFullYear(2099);
      }
    }
  }
}

// 默认导出单例实例
export const cookieStore = new CookieStore();
