/**
 * Cookie 存储管理模块
 * 封装 CookieJar 的存储和访问逻辑，支持持久化到磁盘
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { CookieJar } from "tough-cookie";
import type { MaimaiCookieValues } from "../types/index.ts";
import { dirname } from "node:path";

/** 持久化文件中单个 Bot 条目 */
interface PersistedEntry {
  friendCode: string;
  jar: ReturnType<CookieJar["serializeSync"]>;
  expired: boolean;
}

/** 持久化文件根结构 */
interface PersistedData {
  version: 1;
  updatedAt: string;
  entries: PersistedEntry[];
}

/**
 * Cookie 存储类
 * 管理多个 Bot 账号的 CookieJar，可选持久化到磁盘
 */
export class CookieStore {
  private cookieJars = new Map<string, CookieJar>();
  private expiredBots = new Set<string>();
  private persistPath: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 启用磁盘持久化
   * @param filePath 持久化文件路径
   */
  enablePersistence(filePath: string): void {
    this.persistPath = filePath;
    console.log(`[CookieStore] Persistence enabled: ${filePath}`);
  }

  /**
   * 从磁盘加载 cookie 数据（启动时调用）
   * @returns 恢复的 Bot 数量
   */
  loadFromDisk(): number {
    if (!this.persistPath) return 0;
    if (!existsSync(this.persistPath)) {
      console.log(
        `[CookieStore] No persisted data found at ${this.persistPath}`,
      );
      return 0;
    }

    try {
      const raw = readFileSync(this.persistPath, "utf-8");
      const data: PersistedData = JSON.parse(raw);

      if (data.version !== 1 || !Array.isArray(data.entries)) {
        console.warn(`[CookieStore] Invalid persisted data format, skipping`);
        return 0;
      }

      let restored = 0;
      for (const entry of data.entries) {
        try {
          const jar = CookieJar.deserializeSync(entry.jar);
          this.cookieJars.set(entry.friendCode, jar);
          if (entry.expired) {
            this.expiredBots.add(entry.friendCode);
          }
          restored++;
        } catch (err) {
          console.warn(
            `[CookieStore] Failed to restore cookie for ${entry.friendCode}:`,
            err,
          );
        }
      }

      console.log(
        `[CookieStore] Restored ${restored} bot cookie(s) from disk (saved at ${data.updatedAt})`,
      );
      return restored;
    } catch (err) {
      console.warn(`[CookieStore] Failed to load persisted data:`, err);
      return 0;
    }
  }

  /**
   * 将当前所有 cookie 数据保存到磁盘
   */
  saveToDisk(): void {
    if (!this.persistPath) return;

    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const entries: PersistedEntry[] = [];
      for (const [friendCode, jar] of this.cookieJars) {
        try {
          entries.push({
            friendCode,
            jar: jar.serializeSync(),
            expired: this.expiredBots.has(friendCode),
          });
        } catch (err) {
          console.warn(
            `[CookieStore] Failed to serialize cookie for ${friendCode}:`,
            err,
          );
        }
      }

      const data: PersistedData = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries,
      };

      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(`[CookieStore] Failed to save cookies to disk:`, err);
    }
  }

  /**
   * 延迟保存（防抖 1 秒，避免高频写磁盘）
   */
  private scheduleSave(): void {
    if (!this.persistPath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveToDisk();
      this.saveTimer = null;
    }, 1000);
  }

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
    this.scheduleSave();
  }

  /**
   * 删除指定 friendCode 的 CookieJar
   */
  delete(friendCode: string): boolean {
    const result = this.cookieJars.delete(friendCode);
    if (result) this.scheduleSave();
    return result;
  }

  /**
   * 检查是否存在指定 friendCode 的 CookieJar
   */
  has(friendCode: string): boolean {
    return this.cookieJars.has(friendCode);
  }

  /**
   * 标记指定 Bot 的 Cookie 已过期
   */
  markExpired(friendCode: string): void {
    if (this.cookieJars.has(friendCode)) {
      this.expiredBots.add(friendCode);
      this.scheduleSave();
      console.warn(`[CookieStore] Bot ${friendCode} marked as expired`);
    }
  }

  /**
   * 取消指定 Bot 的过期标记
   */
  markValid(friendCode: string): void {
    if (this.expiredBots.delete(friendCode)) {
      this.scheduleSave();
      console.log(`[CookieStore] Bot ${friendCode} marked as valid`);
    }
  }

  /**
   * 检查指定 Bot 的 Cookie 是否已过期
   */
  isExpired(friendCode: string): boolean {
    return this.expiredBots.has(friendCode);
  }

  /**
   * 获取所有已注册的 Bot friendCode 列表
   */
  getAllBotFriendCodes(): string[] {
    return Array.from(this.cookieJars.keys());
  }

  /**
   * 获取所有未过期的 Bot friendCode 列表
   */
  getAvailableBotFriendCodes(): string[] {
    return Array.from(this.cookieJars.keys()).filter(
      (code) => !this.expiredBots.has(code),
    );
  }

  /**
   * 获取可用 Bot 数量
   */
  get size(): number {
    return this.cookieJars.size;
  }

  /**
   * 清空所有 CookieJar 和过期标记
   */
  clear(): void {
    this.cookieJars.clear();
    this.expiredBots.clear();
    this.scheduleSave();
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

// 启用持久化并从磁盘恢复
const persistPath = process.env.COOKIE_PERSIST_PATH || "./data/cookies.json";
cookieStore.enablePersistence(persistPath);
cookieStore.loadFromDisk();
