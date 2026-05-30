/**
 * 常量定义模块
 * 集中管理所有硬编码常量，避免重复和魔法数字
 */

// ============================================================================
// HTTP Headers
// ============================================================================

/**
 * 微信浏览器 User-Agent
 * 用于模拟微信内置浏览器访问舞萌网站
 */
export const WECHAT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x6307001e)";

export const DEFAULT_HEADERS = {
  Host: "maimai.wahlap.com",
  "User-Agent": WECHAT_USER_AGENT,
} as const;

// ============================================================================
// URLs
// ============================================================================

export const MAIMAI_BASE_URL = "https://maimai.wahlap.com/maimai-mobile";
export const AUTH_BASE_URL = "https://tgk-wcaime.wahlap.com/wc_auth/oauth";

export const MAIMAI_URLS = {
  // 认证
  auth: (type: string) => `${AUTH_BASE_URL}/authorize/${type}`,

  // 首页
  home: `${MAIMAI_BASE_URL}/home/`,

  // 好友相关
  friendList: `${MAIMAI_BASE_URL}/index.php/friend/`,
  friendListPage: (page: number) =>
    `${MAIMAI_BASE_URL}/friend/pages/?idx=${page}`,
  friendInvite: `${MAIMAI_BASE_URL}/friend/invite/`,
  friendAccept: `${MAIMAI_BASE_URL}/friend/accept/`,
  friendAcceptAllow: `${MAIMAI_BASE_URL}/friend/accept/allow/`,
  friendAcceptBlock: `${MAIMAI_BASE_URL}/friend/accept/block/`,
  friendInviteCancel: `${MAIMAI_BASE_URL}/friend/invite/cancel/`,
  friendDetail: `${MAIMAI_BASE_URL}/friend/friendDetail/drop/`,
  friendFavoriteOn: `${MAIMAI_BASE_URL}/friend/favoriteOn/`,
  friendFavoriteOff: `${MAIMAI_BASE_URL}/friend/favoriteOff/`,
  friendSearch: (code: string) =>
    `${MAIMAI_BASE_URL}/friend/search/searchUser/?friendCode=${encodeURIComponent(
      code,
    )}`,
  friendSearchInvite: `${MAIMAI_BASE_URL}/friend/search/invite/`,
  friendVS: (
    code: string,
    scoreType: number,
    diff: number,
    side?: "win" | "lose",
  ) => {
    const sideQuery =
      side === "win" ? "&winOnly=on" : side === "lose" ? "&loseOnly=on" : "";
    return `${MAIMAI_BASE_URL}/friend/friendGenreVs/battleStart/?scoreType=${scoreType}&genre=99&diff=${diff}${sideQuery}&idx=${code}`;
  },
  userFriendCode: `${MAIMAI_BASE_URL}/friend/userFriendCode/`,

  // Cookie 过期检测
  error: `${MAIMAI_BASE_URL}/error/`,
  logout: `${MAIMAI_BASE_URL}/logout/`,
} as const;

// ============================================================================
// Cookie 过期检测
// ============================================================================

export const COOKIE_EXPIRE_LOCATIONS = new Set([
  MAIMAI_URLS.error,
  MAIMAI_URLS.logout,
]);

export const COOKIE_EXPIRE_MARKERS = {
  line1:
    '<div class="p_5 f_12 gray break">连接时间已过期。<br>请于稍后重新尝试。</div>',
  line2: '<div class="p_5 f_12 gray break">再见！</div>',
  errorCode100001: '<div class="p_5 f_14 ">错误码：100001</div>',
  errorCode200002: '<div class="p_5 f_14 ">错误码：200002</div>',
} as const;

// ============================================================================
// 超时和重试配置
// ============================================================================

export const TIMEOUTS = {
  /** 默认请求超时 (ms). 60s — wahlap is slow during peak, and with
   * the 5s per-request spacing, a brief upstream slowdown could push
   * a single fetch over 30s before the response lands. Phone-driven
   * cookie auth in particular hit "signal timed out" on the
   * getUserFriendCode validation step. */
  default: 60_000,
  /** Friend VS 页面请求超时 (ms) */
  friendVS: 5 * 60 * 1000,
  /** 好友请求接受等待超时 (ms) */
  friendAcceptWait: 5 * 60_000,
  /** 单个 job 的硬性超时 (ms). 超过此时间，worker 直接 patch failed +
   * 放弃在飞 HTTP 请求；backend 侧也有同样的 30min 兜底扫描。 */
  jobHardTimeout: 30 * 60_000,
} as const;

export const RETRY = {
  /** 默认重试次数 */
  defaultCount: 3,
  /** Friend VS 重试次数 */
  friendVSCount: 3,
  /** 基础重试间隔 (ms)，实际间隔为 min(baseDelayMs * 2^attempt, maxDelayMs) + jitter */
  baseDelayMs: 1000,
  /** 最大重试间隔 (ms) */
  maxDelayMs: 30_000,
  /** 限流 (567) 默认最大重试次数 */
  rateLimitMaxCount: 3,
  /** 限流 (567) Friend VS 最大重试次数 */
  rateLimitFriendVSMaxCount: 3,
  /** 限流重试基础间隔 (ms)，实际间隔为 min(rateLimitBaseDelayMs * 2^attempt, rateLimitMaxDelayMs) + jitter */
  rateLimitBaseDelayMs: 5_000,
  /** 限流重试最大间隔 (ms) */
  rateLimitMaxDelayMs: 60_000,
} as const;

// ============================================================================
// Worker 配置
// ============================================================================

export const WORKER_DEFAULTS = {
  /** 心跳间隔 (ms) */
  heartbeatIntervalMs: 20_000,
  /** 最大并发处理任务数 */
  maxProcessJobs: 8,
  /** Friend VS 并发数 */
  friendVSConcurrency: 2,
  /** 清理任务间隔 (ms) - 默认 5 分钟 */
  cleanupIntervalMs: 5 * 60_000,
  /** Cookie 健康检查间隔 (ms) - 默认 1 分钟 */
  cookieHealthCheckIntervalMs: 60 * 1000,
  /** Bot 状态上报间隔 (ms) - 默认 1 分钟。QR-login 不再依赖这个 tick
   *  来取 friend list（改用 per-request fetch_friend_list job） */
  botStatusReportIntervalMs: 60_000,
} as const;

// ============================================================================
// 难度定义
// ============================================================================

export const DIFFICULTIES = [0, 1, 2, 3, 4, 10] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
