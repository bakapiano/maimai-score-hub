/**
 * Worker 调度器
 * 负责任务的调度和分配
 */

import { join } from "node:path";

import type { Job } from "../types/index.ts";
import { cookieStore } from "./cookie-store.ts";
import { CookieExpiredError, MaimaiHttpClient } from "./maimai-client.ts";
import { JobHandler, type JobHandlerConfig } from "./job-handler.ts";
import { buildUrl, claimNextJob, updateJob } from "../job-service-client.ts";
import { DEFAULT_HEADERS, WORKER_DEFAULTS } from "../constants.ts";
import { cleanupService } from "./cleanup-service.ts";

/**
 * 从环境变量读取配置
 */
function loadConfigFromEnv(): {
  jobHandlerConfig: JobHandlerConfig;
  maxProcessJobs: number;
  tickIntervalMs: number;
} {
  const useMockResult =
    process.env.USE_MOCK_RESULT === "1" ||
    process.env.USE_MOCK_RESULT?.toLowerCase() === "true";
  const dumpResultToMock =
    process.env.DUMP_RESULT_TO_MOCK === "1" ||
    process.env.DUMP_RESULT_TO_MOCK?.toLowerCase() === "true";
  const mockResultPath =
    process.env.MOCK_RESULT_PATH || join(process.cwd(), "mockResult.json");
  const skipCleanUpFriend =
    process.env.SKIP_CLEANUP_FRIEND === "1" ||
    process.env.SKIP_CLEANUP_FRIEND?.toLowerCase() === "true";
  const heartbeatIntervalMs = Number(
    process.env.JOB_HEARTBEAT_INTERVAL_MS ??
      WORKER_DEFAULTS.heartbeatIntervalMs,
  );
  const dumpFriendVsHtml = process.env.DUMP_FRIEND_VS_HTML === "1";
  const friendVsHtmlDir =
    process.env.FRIEND_VS_HTML_DIR || join(process.cwd(), "debug-html");

  const maxProcessJobsRaw = Number(process.env.MAX_PROCESS_JOBS);
  const maxProcessJobs =
    Number.isFinite(maxProcessJobsRaw) && maxProcessJobsRaw > 0
      ? Math.floor(maxProcessJobsRaw)
      : WORKER_DEFAULTS.maxProcessJobs;

  return {
    jobHandlerConfig: {
      skipCleanUpFriend,
      useMockResult,
      mockResultPath,
      dumpResultToMock,
      dumpFriendVsHtml,
      friendVsHtmlDir,
      heartbeatIntervalMs,
    },
    maxProcessJobs,
    tickIntervalMs: WORKER_DEFAULTS.tickIntervalMs,
  };
}

/**
 * Worker 调度器类
 */
export class WorkerScheduler {
  private processingCount = 0;
  private botIndex = 0;
  private config: ReturnType<typeof loadConfigFromEnv>;
  private intervalId: NodeJS.Timeout | null = null;
  private healthCheckIntervalId: NodeJS.Timeout | null = null;
  private reportIntervalId: NodeJS.Timeout | null = null;
  private paused = false;

  constructor() {
    this.config = loadConfigFromEnv();

    // 设置清理服务的回调
    cleanupService.setCallbacks(
      () => {
        this.paused = true;
      },
      () => {
        this.paused = false;
      },
    );
  }

  /**
   * 启动 Worker
   */
  start(): void {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(
      () => this.tick(),
      this.config.tickIntervalMs,
    );

    // 启动 Cookie 健康检查
    this.startCookieHealthCheck();

    // 启动 Bot 状态上报
    this.startBotStatusReporting();

    // 启动清理服务
    cleanupService.start();

    console.log("[WorkerScheduler] Started");
  }

  /**
   * 停止 Worker
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }
    if (this.reportIntervalId) {
      clearInterval(this.reportIntervalId);
      this.reportIntervalId = null;
    }
    cleanupService.stop();
    console.log("[WorkerScheduler] Stopped");
  }

  /**
   * 启动 Cookie 健康检查定时器
   * 定期检测所有 Bot 的 Cookie 是否过期
   */
  private startCookieHealthCheck(): void {
    // 启动时立即检查一次
    this.checkAllCookies().catch((err) =>
      console.error(
        "[WorkerScheduler] Initial cookie health check failed:",
        err,
      ),
    );

    this.healthCheckIntervalId = setInterval(() => {
      this.checkAllCookies().catch((err) =>
        console.error("[WorkerScheduler] Cookie health check failed:", err),
      );
    }, WORKER_DEFAULTS.cookieHealthCheckIntervalMs);
    console.log(
      `[WorkerScheduler] Cookie health check started (interval: ${WORKER_DEFAULTS.cookieHealthCheckIntervalMs}ms)`,
    );
  }

  /**
   * 检测所有 Bot 的 Cookie 是否过期
   */
  private async checkAllCookies(): Promise<void> {
    const allBots = cookieStore.getAllBotFriendCodes();
    if (!allBots.length) return;

    const results = await Promise.allSettled(
      allBots.map(async (friendCode) => {
        const jar = cookieStore.get(friendCode);
        if (!jar) return;

        try {
          const client = new MaimaiHttpClient(jar);
          await client.fetch(
            "https://maimai.wahlap.com/maimai-mobile/home/",
            { headers: DEFAULT_HEADERS },
            undefined,
          );
          // Cookie 有效，取消过期标记
          cookieStore.markValid(friendCode);
        } catch (err) {
          if (err instanceof CookieExpiredError) {
            cookieStore.markExpired(friendCode);
          } else {
            console.error(
              `[WorkerScheduler] Cookie health check error for bot ${friendCode}:`,
              err,
            );
          }
        }
      }),
    );

    const availableCount = cookieStore.getAvailableBotFriendCodes().length;
    const expiredCount = allBots.length - availableCount;
    if (expiredCount > 0) {
      console.warn(
        `[WorkerScheduler] Cookie health check: ${availableCount}/${allBots.length} bots available, ${expiredCount} expired`,
      );
    } else {
      console.log(
        `[WorkerScheduler] Cookie health check: all ${allBots.length} bots available`,
      );
    }
  }

  /**
   * 启动 Bot 状态上报定时器
   * 定期向后端报告 Bot 可用情况
   */
  private startBotStatusReporting(): void {
    // 启动时立即上报一次
    this.reportBotStatus().catch((err) =>
      console.error("[WorkerScheduler] Initial bot status report failed:", err),
    );

    this.reportIntervalId = setInterval(() => {
      this.reportBotStatus().catch((err) =>
        console.error("[WorkerScheduler] Bot status report failed:", err),
      );
    }, WORKER_DEFAULTS.botStatusReportIntervalMs);
    console.log(
      `[WorkerScheduler] Bot status reporting started (interval: ${WORKER_DEFAULTS.botStatusReportIntervalMs}ms)`,
    );
  }

  /**
   * 向后端上报所有 Bot 的状态
   */
  private async reportBotStatus(): Promise<void> {
    return reportBotStatus();
  }

  /**
   * Worker 主循环 tick
   * 每次 tick 只领取一个任务，避免单个 worker 在一次 tick 中贪心抢占所有任务导致负载倾斜
   */
  private async tick(): Promise<void> {
    if (this.paused || this.processingCount >= this.config.maxProcessJobs) {
      return;
    }

    const availableBots = cookieStore.getAvailableBotFriendCodes();
    if (!availableBots.length) {
      return;
    }

    const botFriendCode = availableBots[this.botIndex % availableBots.length];
    this.botIndex++;

    try {
      const job = await claimNextJob(botFriendCode);
      if (!job) {
        return;
      }

      this.processingCount++;
      console.log(
        `[WorkerScheduler] Processing job. Current count: ${this.processingCount}, Max: ${this.config.maxProcessJobs}`,
      );
      this.handleJob(job)
        .catch((err) => {
          console.error("[WorkerScheduler] Failed to process job:", err);
        })
        .finally(() => {
          this.processingCount--;
        });
    } catch (err) {
      console.error("[WorkerScheduler] Failed to claim job:", err);
    }
  }

  /**
   * 处理单个任务
   */
  private async handleJob(initialJob: Job): Promise<void> {
    let job = initialJob;

    // 选择 Bot（仅使用未过期的）
    const availableBots = cookieStore.getAvailableBotFriendCodes();
    if (!availableBots.length) {
      await updateJob(job.id, {
        status: "failed",
        error: "没有可用的 Bot",
      });
      return;
    }

    if (!job.botUserFriendCode || !cookieStore.has(job.botUserFriendCode)) {
      const selectedBot =
        availableBots[Math.floor(Math.random() * availableBots.length)];
      job = await updateJob(job.id, {
        botUserFriendCode: selectedBot,
        updatedAt: new Date(),
      });
    }

    const botFriendCode = job.botUserFriendCode!;
    const cookieJar = cookieStore.get(botFriendCode);
    if (!cookieJar) {
      await updateJob(job.id, {
        status: "failed",
        error: `Bot ${botFriendCode} 的 Cookie 未找到`,
      });
      return;
    }

    const client = new MaimaiHttpClient(cookieJar);
    const handler = new JobHandler(job, client, this.config.jobHandlerConfig);
    await handler.execute();
  }
}

/**
 * 向后端上报所有 Bot 的状态
 * 可由 WorkerScheduler 定时调用，也可在 Bot 登录成功后主动调用
 */
export async function reportBotStatus(): Promise<void> {
  const allBots = cookieStore.getAllBotFriendCodes();
  if (!allBots.length) return;

  const botsData: {
    friendCode: string;
    available: boolean;
    friendCount?: number;
  }[] = [];

  for (const friendCode of allBots) {
    if (cookieStore.isExpired(friendCode)) continue;

    let friendCount: number | undefined;
    try {
      const jar = cookieStore.get(friendCode);
      if (jar) {
        const client = new MaimaiHttpClient(jar);
        const friends = await client.getFriendList();
        friendCount = friends.length;
      }
    } catch {
      // Best effort - don't fail the report
    }

    botsData.push({ friendCode, available: true, friendCount });
  }

  if (!botsData.length) return;

  try {
    const response = await fetch(buildUrl("/api/admin/bot-status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bots: botsData }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `[BotStatusReport] Report failed: ${response.status} ${text}`,
      );
    }
  } catch (err) {
    console.error("[BotStatusReport] Report error:", err);
  }
}

/**
 * 启动 Worker（兼容旧接口）
 */
export function startWorker(): void {
  const scheduler = new WorkerScheduler();
  scheduler.start();
}
