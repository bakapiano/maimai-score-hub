/**
 * 全局内存状态模块
 * 仅保留简单的运行时状态变量，Cookie 管理已迁移到 CookieStore
 */

import { CookieJar } from "tough-cookie";
import { cookieStore } from "./services/cookie-store.ts";

/**
 * 认证超时时间（毫秒）
 *
 * 30s — auth IIFE in proxy.ts has its own 90s hard cap; this is the
 * "if nobody calls finishAuth" backstop and just gates /api/status.
 * Keep it short so a stuck/abandoned auth doesn't lock new attempts.
 */
const AUTH_TIMEOUT_MS = 30_000;

/**
 * 运行时状态
 * 用于存储临时的运行时变量
 */
export const runtimeState = {
  /** 当前 OAuth 认证 URL（供 proxy 使用） */
  authUrl: "",

  /** OAuth 完成后的重定向 URL（由前端发起 auth 时传入） */
  redirectUrl: "",

  /** 正在进行中的认证状态 */
  _ongoingAuth: null as {
    startedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null,

  /** 标记认证开始 */
  startAuth(): void {
    // 清除旧的 timer
    if (runtimeState._ongoingAuth) {
      clearTimeout(runtimeState._ongoingAuth.timer);
    }
    const timer = setTimeout(() => {
      console.log("[Auth] Auth timed out after 1 minute");
      runtimeState._ongoingAuth = null;
    }, AUTH_TIMEOUT_MS);
    runtimeState._ongoingAuth = { startedAt: Date.now(), timer };
    console.log("[Auth] Auth started");
  },

  /** 标记认证结束 */
  finishAuth(): void {
    if (runtimeState._ongoingAuth) {
      clearTimeout(runtimeState._ongoingAuth.timer);
      runtimeState._ongoingAuth = null;
      console.log("[Auth] Auth finished");
    }
  },

  /** 是否正在进行认证 */
  get isAuthOngoing(): boolean {
    return runtimeState._ongoingAuth !== null;
  },
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
