import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Worker 运行配置模块。
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath =
  process.env.ENV_PATH || path.join(__dirname, "..", "..", ".env");

function parseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;

  const key = trimmed.slice(0, eq).trim();
  if (!key) return null;

  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

export function loadEnv() {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

loadEnv();

function getEnvInt(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

// ============================================================================
// Worker 配置
// ============================================================================

export const WORKER_DEFAULTS = {
  /** Friend VS 并发数 */
  friendVSConcurrency: 2,
  /** 清理任务间隔 (ms) - 默认 5 分钟 */
  cleanupIntervalMs: 5 * 60_000,
  /** Cookie 健康检查间隔 (ms) - 默认 1 分钟 */
  cookieHealthCheckIntervalMs: 60 * 1000,
  /** Bot 状态上报间隔 (ms) - 默认 1 分钟 */
  botStatusReportIntervalMs: 60_000,
  /** Bot 好友列表快照刷新间隔 (ms) - 默认 5 分钟 */
  botFriendListRefreshIntervalMs: getEnvInt(
    "BOT_FRIEND_LIST_REFRESH_INTERVAL_MS",
    5 * 60_000,
  ),
  /** BullMQ job 因 bot 暂不可用而延后重试的时间 (ms) */
  queueRetryDelayMs: getEnvInt("BULLMQ_JOB_RETRY_DELAY_MS", 5_000),
} as const;

const env = process.env.NODE_ENV || "dev";

const config = {
  dev: env === "dev",
  port: parseInt(process.env.API_PORT || "3999", 10),
  fetchTimeOut: parseInt(process.env.FETCH_TIMEOUT || "300000", 10),
  httpProxy: {
    port: parseInt(process.env.HTTP_PROXY_PORT || "2222", 10),
    // Basic auth password for the HTTP/CONNECT proxy. If empty/unset,
    // proxy runs without auth (legacy behavior).
    proxyPassword: process.env.HTTP_PROXY_PASSWORD || "",
  },
  jobService: {
    baseUrl:
      process.env.JOB_SERVICE_BASE_URL ||
      "https://api.maiscorehub.bakapiano.com/",
  },
};

export default config;
