/**
 * 舞萌 DX 协议和业务常量。
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
  auth: (type: string) => `${AUTH_BASE_URL}/authorize/${type}`,
  home: `${MAIMAI_BASE_URL}/home/`,
  friendList: `${MAIMAI_BASE_URL}/index.php/friend/`,
  friendListPage: (page: number) =>
    `${MAIMAI_BASE_URL}/friend/pages/?idx=${page}`,
  friendInvite: `${MAIMAI_BASE_URL}/friend/invite/`,
  friendAccept: `${MAIMAI_BASE_URL}/friend/accept/`,
  friendAcceptAllow: `${MAIMAI_BASE_URL}/friend/accept/allow/`,
  friendAcceptBlock: `${MAIMAI_BASE_URL}/friend/accept/block/`,
  friendInviteCancel: `${MAIMAI_BASE_URL}/friend/invite/cancel/`,
  friendDetailPage: (code: string) =>
    `${MAIMAI_BASE_URL}/friend/friendDetail/?idx=${encodeURIComponent(code)}`,
  friendDetail: `${MAIMAI_BASE_URL}/friend/friendDetail/drop/`,
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
  /** 默认请求超时 (ms). */
  default: 60_000,
  /** Friend VS 页面请求超时 (ms) */
  friendVS: 5 * 60 * 1000,
  /** 好友请求接受等待超时 (ms) */
  friendAcceptWait: 5 * 60_000,
  /** 单个 job 的硬性超时 (ms). */
  jobHardTimeout: 30 * 60_000,
} as const;

export const RETRY = {
  defaultCount: 3,
  friendVSCount: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  rateLimitMaxCount: 3,
  rateLimitFriendVSMaxCount: 3,
  rateLimitBaseDelayMs: 5_000,
  rateLimitMaxDelayMs: 60_000,
} as const;

// ============================================================================
// 难度定义
// ============================================================================

export const DIFFICULTIES = [0, 1, 2, 3, 4, 10] as const;
