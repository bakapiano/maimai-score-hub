/**
 * 全局内存状态模块
 * 仅保留简单的运行时状态变量，Cookie 管理已迁移到 CookieStore
 */

import { CookieJar } from "tough-cookie";
import { cookieStore } from "./services/cookie-store.ts";

/**
 * 运行时状态
 * 用于存储临时的运行时变量
 */
export const runtimeState = {
  /** 当前 OAuth 认证 URL（供 proxy 使用） */
  authUrl: "",
};

/**
 * @deprecated 使用 cookieStore 替代
 * 保留旧的 state 导出以保持向后兼容，后续逐步迁移
 */
export const state = {
  get isCookieExpired(): boolean {
    // 已废弃，总是返回 false
    return false;
  },
  set isCookieExpired(_value: boolean) {
    // 已废弃，不做任何操作
  },
  authUrl: "",
  /** @deprecated 使用 cookieStore 替代 */
  cookieJars: new Map<string, CookieJar>(),
};

// 重新导出 cookieStore 供其他模块使用
export { cookieStore };
