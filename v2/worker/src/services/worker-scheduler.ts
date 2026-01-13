/**
 * Worker 调度器
 * 负责任务的调度和分配
 */

import { join } from "node:path";
import { CookieJar } from "tough-cookie";

import type { Job } from "../types/index.ts";
import { cookieStore } from "./cookie-store.ts";
import { MaimaiHttpClient } from "./maimai-client.ts";
import { JobHandler, type JobHandlerConfig } from "./job-handler.ts";
import { claimNextJob, updateJob } from "../job-service-client.ts";
import { WORKER_DEFAULTS } from "../constants.ts";

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
    process.env.JOB_HEARTBEAT_INTERVAL_MS ?? WORKER_DEFAULTS.heartbeatIntervalMs
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

  constructor() {
    this.config = loadConfigFromEnv();
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
      this.config.tickIntervalMs
    );

    console.log("[WorkerScheduler] Started");
  }

  /**
   * 停止 Worker
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[WorkerScheduler] Stopped");
    }
  }

  /**
   * Worker 主循环 tick
   */
  private async tick(): Promise<void> {
    if (this.processingCount >= this.config.maxProcessJobs) {
      return;
    }

    const availableBots = cookieStore.getAllBotFriendCodes();
    if (!availableBots.length) {
      return;
    }

    while (this.processingCount < this.config.maxProcessJobs) {
      const botFriendCode = availableBots[this.botIndex % availableBots.length];
      this.botIndex++;

      try {
        const job = await claimNextJob(botFriendCode);
        if (!job) {
          break;
        }

        this.processingCount++;
        this.handleJob(job)
          .catch((err) => {
            console.error("[WorkerScheduler] Failed to process job:", err);
          })
          .finally(() => {
            this.processingCount--;
          });
      } catch (err) {
        console.error("[WorkerScheduler] Failed to claim job:", err);
        break;
      }
    }
  }

  /**
   * 处理单个任务
   */
  private async handleJob(initialJob: Job): Promise<void> {
    let job = initialJob;

    // 选择 Bot
    const availableBots = cookieStore.getAllBotFriendCodes();
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
 * 启动 Worker（兼容旧接口）
 */
export function startWorker(): void {
  const scheduler = new WorkerScheduler();
  scheduler.start();
}
