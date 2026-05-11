/**
 * 任务处理器
 * 负责处理单个同步任务的完整生命周期
 */

import type {
  AggregatedScoreResult,
  Job,
  JobPatch,
  SentFriendRequest,
} from "../types/index.ts";
import { CookieExpiredError, MaimaiHttpClient } from "./maimai-client.ts";
import { DIFFICULTIES, TIMEOUTS } from "../constants.ts";
import {
  checkIsIdleUpdateBot,
  markIdleUpdateReady,
  updateJob,
} from "../clients/job-service-client.ts";
import {
  clearApiLogBuffer,
  flushApiLogs,
} from "../clients/job-api-log-client.ts";
import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { FriendManager } from "./friend-manager.ts";
import { ScoreAggregator } from "./score-aggregator.ts";
import { cookieStore } from "./cookie-store.ts";
import { randomUUID } from "node:crypto";

/**
 * 解析日期字符串，兼容旧格式的 CST 本地时间（如 "2026/02/23 23:31"）
 * 和标准 ISO 8601 格式。
 */
function parseDateAsCST(dateStr: string): Date {
  // ISO 格式（含 T 或 Z）直接解析
  if (dateStr.includes("T") || dateStr.includes("Z")) {
    return new Date(dateStr);
  }
  // 旧格式：舞萌网站的 CST (UTC+8) 本地时间
  return new Date(`${dateStr.replace(/\//g, "-")}:00+08:00`);
}

export interface JobHandlerConfig {
  /** 是否跳过好友清理 */
  skipCleanUpFriend: boolean;
  /** 是否使用 Mock 结果 */
  useMockResult: boolean;
  /** Mock 结果文件路径 */
  mockResultPath: string;
  /** 是否导出结果到 Mock 文件 */
  dumpResultToMock: boolean;
  /** 是否导出 Friend VS HTML */
  dumpFriendVsHtml: boolean;
  /** Friend VS HTML 导出目录 */
  friendVsHtmlDir: string;
  /** 心跳间隔 (ms) */
  heartbeatIntervalMs: number;
}

/**
 * 任务处理器
 */
export class JobHandler {
  private job: Job;
  private client: MaimaiHttpClient;
  private friendManager: FriendManager;
  private scoreAggregator: ScoreAggregator;
  private config: JobHandlerConfig;
  private heartbeat: NodeJS.Timeout | null = null;
  private friendVsDumpReady: Promise<void> | null = null;

  constructor(job: Job, client: MaimaiHttpClient, config: JobHandlerConfig) {
    this.job = job;
    this.client = client;
    this.friendManager = new FriendManager(client);
    this.scoreAggregator = new ScoreAggregator(client);
    this.config = config;
  }

  /**
   * 执行任务
   */
  async execute(): Promise<void> {
    try {
      this.startHeartbeat();
      this.client.jobId = this.job.id;

      // fetch_friend_list jobs aren't tied to a target user — friendCode
      // on the job is just the bot's own friendCode for routing. Skip
      // the user-profile lookup; the handler only fetches the bot's
      // friend list.
      if (this.job.jobType !== "fetch_friend_list" && !this.job.profile) {
        const profile = await this.client.getUserProfile(this.job.friendCode);
        if (!profile) {
          throw new Error(
            "未找到该好友代码对应的用户，请检查好友代码是否正确!",
          );
        }
        await this.applyPatch({ profile, updatedAt: new Date() });
      }

      // 根据当前阶段处理
      switch (this.job.stage) {
        case "send_request":
          await this.handleSendRequest();
          break;
        case "wait_acceptance":
          await this.handleWaitAcceptance();
          break;
        case "update_score":
          await this.handleUpdateScore();
          break;
        case "fetch_friend_list":
          await this.handleFetchFriendList();
          break;
      }
    } catch (e: unknown) {
      // CookieExpiredError 不标记为 failed，让任务可以重试
      if (e instanceof CookieExpiredError) {
        // 标记该 Bot 的 Cookie 已过期，阻止后续使用
        if (this.job.botUserFriendCode) {
          cookieStore.markExpired(this.job.botUserFriendCode);
        }
        console.warn(
          `[JobHandler] Job ${this.job.id}: Cookie expired, bot marked as expired, will retry later`,
        );
        return;
      }

      const error = e as Error;
      console.error(`[JobHandler] Job ${this.job.id} failed:`, error);
      await this.applyPatch({
        status: "failed",
        error: error?.message || String(error),
        updatedAt: new Date(),
      });
    } finally {
      this.stopHeartbeat();

      // 上报并清理 API 日志
      await flushApiLogs(this.job.id).catch((err) => {
        console.warn(
          `[JobHandler] Job ${this.job.id}: Failed to flush API logs`,
          err,
        );
      });
      clearApiLogBuffer(this.job.id);
      this.client.jobId = null;

      if (this.job.executing) {
        try {
          await this.applyPatch({ executing: false });
        } catch (releaseErr) {
          console.error(
            `[JobHandler] Job ${this.job.id}: failed to release execution flag`,
            releaseErr,
          );
        }
      }
    }
  }

  /**
   * 处理发送好友请求阶段
   */
  private async handleSendRequest(): Promise<void> {
    console.log(`[JobHandler] Job ${this.job.id}: Sending friend request...`);

    // 登录后创建的 job，先检查是否已经是好友，如果是则跳过发送好友请求
    if (this.job.isAuthenticated) {
      const alreadyFriend = await this.friendManager.isFriend(
        this.job.friendCode,
      );
      if (alreadyFriend) {
        console.log(
          `[JobHandler] Job ${this.job.id}: Authenticated job - already friends, skipping send_request`,
        );
        await this.applyPatch({
          stage: "wait_acceptance",
          updatedAt: new Date(),
        });
        return;
      }
    }

    let match: SentFriendRequest | undefined;

    try {
      // 记录当前 UTC+8 时间（精确到分钟，与舞萌网站申请日期精度一致）
      const nowCST = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const sendTimestamp = new Date(
        Date.UTC(
          nowCST.getUTCFullYear(),
          nowCST.getUTCMonth(),
          nowCST.getUTCDate(),
          nowCST.getUTCHours(),
          nowCST.getUTCMinutes(),
          0,
          0,
        ),
      );
      const sendThreshold = sendTimestamp.getTime() - 8 * 60 * 60 * 1000;
      console.log(
        `[JobHandler] Job ${this.job.id}: Send threshold (UTC): ${new Date(sendThreshold).toISOString()}`,
      );

      // 先执行一次发送 + 验证（batch：两步紧邻，跳过 spacing）
      await MaimaiHttpClient.runInBatch(async () => {
        await this.friendManager.sendFriendRequest(this.job.friendCode);

        // 检查初次发送的结果
        const sentRequests = await this.friendManager.getSentRequests();
        const found = sentRequests.find(
          (s) => s.friendCode === this.job.friendCode,
        );
        if (found && found.appliedAt) {
          const appliedTime = new Date(found.appliedAt).getTime();
          if (appliedTime >= sendThreshold) {
            // appliedAt >= sendThreshold，是本次发送的有效请求
            match = found;
          }
        }
      }, "send+verify-friend-request");
    } catch (err) {
      console.warn(
        `[JobHandler] Job ${this.job.id}: Failed to verify sent friend request:`,
        err,
      );
    }

    // 如果初次验证未拿到有效 match，进入重试循环
    if (!match) {
      if (!this.config.skipCleanUpFriend) {
        await this.friendManager.cleanUpFriend(this.job.friendCode);
      }

      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // batch：send + isFriend + getSent 视为一次操作，跳过 spacing
        const result = await MaimaiHttpClient.runInBatch(async () => {
          await this.friendManager.sendFriendRequest(this.job.friendCode);

          // 发送后检查是否已经是好友
          const alreadyFriend = await this.friendManager.isFriend(
            this.job.friendCode,
          );
          if (alreadyFriend) {
            return { kind: "already-friend" as const };
          }

          const sentRequests = await this.friendManager.getSentRequests();
          const m = sentRequests.find(
            (s) => s.friendCode === this.job.friendCode,
          );
          return { kind: "checked" as const, match: m };
        }, "send+verify-friend-request-retry");

        if (result.kind === "already-friend") {
          console.log(
            `[JobHandler] Job ${this.job.id}: Already friends after sending request, treating as success`,
          );
          break;
        }
        match = result.match;

        if (match || this.config.skipCleanUpFriend) {
          break;
        }

        if (attempt < maxRetries) {
          console.warn(
            `[JobHandler] Job ${this.job.id}: Friend request not found in sent list, retrying (${attempt}/${maxRetries})...`,
          );
          await this.sleep(10_000);
        }
      }
    }

    if (!this.config.skipCleanUpFriend && !match) {
      throw new Error("发送好友请求失败");
    }

    await this.applyPatch({ stage: "wait_acceptance", updatedAt: new Date() });

    await this.applyPatch({
      friendRequestSentAt: match?.appliedAt ?? new Date().toISOString(),
      updatedAt: new Date(),
    });
  }

  /**
   * 处理等待好友接受阶段
   */
  private async handleWaitAcceptance(): Promise<void> {
    console.log(`[JobHandler] Job ${this.job.id}: Waiting for acceptance...`);

    // 检查是否有待接受的请求
    await this.friendManager.acceptFriendRequestIfPending(this.job.friendCode);

    // 检查是否已经是好友
    const isFriend = await this.friendManager.isFriend(this.job.friendCode);

    if (isFriend) {
      console.log(`[JobHandler] Job ${this.job.id}: Friend accepted!`);
      await this.applyPatch({ stage: "update_score", updatedAt: new Date() });
    } else {
      const sentAt = this.job.friendRequestSentAt
        ? parseDateAsCST(this.job.friendRequestSentAt)
        : this.job.createdAt;
      const elapsed = Date.now() - sentAt.getTime();
      if (elapsed > TIMEOUTS.friendAcceptWait) {
        // 超时时取消好友请求
        try {
          await this.friendManager.cancelFriendRequest(this.job.friendCode);
          console.log(
            `[JobHandler] Job ${this.job.id}: Cancelled friend request due to timeout`,
          );
        } catch (cancelErr) {
          console.warn(
            `[JobHandler] Job ${this.job.id}: Failed to cancel friend request:`,
            cancelErr,
          );
        }
        throw new Error("等待好友接受请求超时");
      }

      // Check if the friend request is still pending
      let match: SentFriendRequest | undefined;

      for (let attempt = 1; attempt <= 3; attempt++) {
        const sentRequests = await this.friendManager.getSentRequests();
        match = sentRequests.find((s) => s.friendCode === this.job.friendCode);

        if (match) {
          break;
        }

        if (attempt < 3) {
          await this.sleep(10_000);
        }
      }

      if (!match) {
        const isFriendAfterRetry = await this.friendManager.isFriend(
          this.job.friendCode,
        );
        if (isFriendAfterRetry) {
          console.log(`[JobHandler] Job ${this.job.id}: Friend accepted!`);
          await this.applyPatch({
            stage: "update_score",
            updatedAt: new Date(),
          });
          return;
        }
        throw new Error("好友请求已被取消或删除");
      }

      // 故意将 updatedAt 推迟 30 秒，让其他排队任务有机会先被处理
      const delayedAt = new Date(Date.now() + 30_000);
      await this.applyPatch({ updatedAt: delayedAt });
      console.log(
        `[JobHandler] Job ${this.job.id}: Friend not yet accepted, delaying updatedAt by 30s`,
      );
    }
  }

  /**
   * Per-request friend-list fetch for the QR-login flow.
   *
   * The QR-login service creates two of these jobs (one before addRival,
   * one after) for the same bot, then diffs the resulting friend lists
   * by friendCode to identify the user that just joined. We don't sync
   * scores, don't add anything, don't remove anything — just GET the
   * page and surface the parsed list in result.friends.
   */
  private async handleFetchFriendList(): Promise<void> {
    const friends = await this.client.getFriendList();
    await this.applyPatch({
      status: "completed",
      result: { friends },
      updatedAt: new Date(),
    });
  }

  /**
   * 处理更新成绩阶段
   */
  private async handleUpdateScore(): Promise<void> {
    const jobType = this.job.jobType ?? "immediate";

    // idle_update_score: 需要确认用户仍是好友
    if (jobType === "idle_update_score") {
      const isFriend = await this.friendManager.isFriend(this.job.friendCode);
      if (!isFriend) {
        console.log(
          `[JobHandler] Job ${this.job.id}: idle_update_score - not a friend, skipping`,
        );
        await this.applyPatch({
          status: "failed",
          error: "闲时更新：用户不是好友，跳过",
          updatedAt: new Date(),
        });
        return;
      }
    }

    if (this.job.skipUpdateScore) {
      console.log(
        `[JobHandler] Job ${this.job.id}: Skipping update_score (skipUpdateScore=true).`,
      );
      await this.completeJob();
      return;
    }

    console.log(`[JobHandler] Job ${this.job.id}: Updating scores...`);
    const updateScoreStartTime = Date.now();

    // 默认跳过 BASIC(0) / ADVANCED(1) / 宴会场(10)，只有显式 fullSync 才爬全部
    const SKIP_DEFAULT = new Set([0, 1, 10]);
    let effectiveDiffs = this.job.fullSync
      ? [...DIFFICULTIES]
      : DIFFICULTIES.filter((d) => !SKIP_DEFAULT.has(d));

    // backend 已经基于 cabinet diff 算好"哪些 diff 真有变化"，只爬这些。
    // 跟 fullSync / 默认 skip 取交集，确保不会反向扩大爬取范围。
    if (Array.isArray(this.job.diffsToScrape) && this.job.diffsToScrape.length > 0) {
      const requested = new Set(this.job.diffsToScrape);
      effectiveDiffs = effectiveDiffs.filter((d) => requested.has(d));
      console.log(
        `[JobHandler] Job ${this.job.id}: backend pinned diffsToScrape=[${this.job.diffsToScrape.join(',')}], scraping [${effectiveDiffs.join(',')}]`,
      );
    }

    // 当 backend 已经拿到了 cabinet 上的 dxScore + achievement 时，
    // worker 只需要 scrape friend-VS scoreType=2 (拿 fc/fs)，dxScore
    // 那一遍可以省掉。backend 在 sync.service 里把 cabinet 数据 merge
    // 到最终 ScoreSnapshot。
    const skipDxScoreFetch =
      !!this.job.cabinetScoreMap &&
      Object.keys(this.job.cabinetScoreMap).length > 0;
    if (skipDxScoreFetch) {
      console.log(
        `[JobHandler] Job ${this.job.id}: skipDxScoreFetch=true (cabinet data has ${Object.keys(this.job.cabinetScoreMap!).length} entries)`,
      );
    }

    // 初始化进度跟踪
    const totalDiffs = effectiveDiffs.length;
    let completedCount = 0;

    // 初始化进度状态
    await this.applyPatch({
      scoreProgress: { completedDiffs: [], totalDiffs },
      updatedAt: new Date(),
    });

    let aggregated: AggregatedScoreResult;

    if (this.config.useMockResult) {
      console.log(
        `[JobHandler] Job ${this.job.id}: Using mock result (MOCK_RESULT_PATH=${this.config.mockResultPath}).`,
      );
      aggregated = await this.loadMockResult();
      // Mock 模式下直接标记所有难度完成
      await this.applyPatch({
        scoreProgress: { completedDiffs: [...effectiveDiffs], totalDiffs },
        updatedAt: new Date(),
      });
    } else {
      console.log(
        `[JobHandler] Job ${this.job.id}: Fetching scores for all diffs...`,
      );
      aggregated = await this.scoreAggregator.fetchAndAggregate(
        this.job.friendCode,
        {
          jobId: this.job.id,
          diffs: effectiveDiffs,
          skipDxScoreFetch,
          dumpHtml: this.config.dumpFriendVsHtml
            ? (html, meta) => this.dumpFriendVsHtml(html, meta)
            : undefined,
          onDiffCompleted: async (diff: number) => {
            completedCount++;
            console.log(
              `[JobHandler] Job ${this.job.id}: Diff ${diff} completed (${completedCount}/${totalDiffs})`,
            );
            // 使用 addCompletedDiff 原子操作，避免并发冲突
            await this.applyPatch({
              addCompletedDiff: diff,
              updatedAt: new Date(),
            });
          },
        },
      );

      if (this.config.dumpResultToMock) {
        await this.dumpMockResult(aggregated);
      }
    }

    const updateScoreDuration = Date.now() - updateScoreStartTime;
    await this.applyPatch({
      result: aggregated,
      status: "completed",
      error: null,
      updateScoreDuration,
      updatedAt: new Date(),
    });

    // 取消收藏好友（不等待完成，默认都进行）
    this.friendManager.favoriteOffFriend(this.job.friendCode).catch(() => {});

    // 清理好友关系（不等待完成）
    // idle_update_score job 完成后也清理好友（因为调度器已清除 user 标记）
    // 对于 immediate job，如果当前 bot 是用户的闲时更新 bot，跳过删除好友
    // let shouldSkipCleanup =
    //   this.config.skipCleanUpFriend || jobType === "idle_add_friend";
    // if (
    //   !shouldSkipCleanup &&
    //   jobType === "immediate" &&
    //   this.job.botUserFriendCode
    // ) {
    //   try {
    //     const isIdleBot = await checkIsIdleUpdateBot(
    //       this.job.friendCode,
    //       this.job.botUserFriendCode,
    //     );
    //     if (isIdleBot) {
    //       shouldSkipCleanup = true;
    //       console.log(
    //         `[JobHandler] Job ${this.job.id}: Skipping friend cleanup (bot is idle update bot for this user)`,
    //       );
    //     }
    //   } catch {
    //     // Best effort check
    //   }
    // }
    // if (!shouldSkipCleanup) {
    //   this.friendManager.cleanUpFriend(this.job.friendCode).catch(() => {});
    // }

    const cost = this.job.updatedAt.getTime() - this.job.createdAt.getTime();
    console.log(`[JobHandler] Job ${this.job.id}: Completed! Cost: ${cost}ms`);
  }

  /**
   * 完成任务（不更新成绩）
   */
  private async completeJob(): Promise<void> {
    const jobType = this.job.jobType ?? "immediate";

    await this.applyPatch({
      status: "completed",
      error: null,
      updatedAt: new Date(),
    });

    // idle_add_friend job 完成后通知后端标记用户已 ready
    if (jobType === "idle_add_friend" && this.job.botUserFriendCode) {
      try {
        await markIdleUpdateReady(
          this.job.friendCode,
          this.job.botUserFriendCode,
        );
        console.log(
          `[JobHandler] Job ${this.job.id}: Marked user ${this.job.friendCode} as idle update ready with bot ${this.job.botUserFriendCode}`,
        );
      } catch (err) {
        console.warn(
          `[JobHandler] Job ${this.job.id}: Failed to mark idle update ready:`,
          err,
        );
      }
      // Don't clean up friend for idle_add_friend jobs
      return;
    }

    // if (!this.config.skipCleanUpFriend) {
    //   // 对于 immediate job，如果当前 bot 是用户的闲时更新 bot，跳过删除好友
    //   let shouldSkip = false;
    //   if (jobType === "immediate" && this.job.botUserFriendCode) {
    //     try {
    //       shouldSkip = await checkIsIdleUpdateBot(
    //         this.job.friendCode,
    //         this.job.botUserFriendCode,
    //       );
    //     } catch {
    //       // Best effort
    //     }
    //   }
    //   if (!shouldSkip) {
    //     this.friendManager.cleanUpFriend(this.job.friendCode).catch(() => {});
    //   }
    // }
  }

  /**
   * 加载 Mock 结果
   */
  private async loadMockResult(): Promise<AggregatedScoreResult> {
    const content = await readFile(this.config.mockResultPath, "utf8");
    const parsed = JSON.parse(content);
    return parsed.result ?? parsed;
  }

  /**
   * 导出结果到 Mock 文件
   */
  private async dumpMockResult(
    aggregated: AggregatedScoreResult,
  ): Promise<void> {
    try {
      await mkdir(dirname(this.config.mockResultPath), { recursive: true });
      await writeFile(
        this.config.mockResultPath,
        JSON.stringify({ result: aggregated }, null, 2),
        "utf8",
      );
      console.log(
        `[JobHandler] Job ${this.job.id}: Dumped aggregated result to ${this.config.mockResultPath}.`,
      );
    } catch (err) {
      console.warn(
        `[JobHandler] Job ${this.job.id}: Failed to dump aggregated result:`,
        err,
      );
    }
  }

  /**
   * 导出 Friend VS HTML（调试用）
   */
  private async dumpFriendVsHtml(
    html: string,
    meta: { type: number; diff: number },
  ): Promise<void> {
    try {
      const dir = this.config.friendVsHtmlDir;
      if (!this.friendVsDumpReady) {
        this.friendVsDumpReady = (async () => {
          await rm(dir, { recursive: true, force: true });
          await mkdir(dir, { recursive: true });
        })();
      }
      await this.friendVsDumpReady;

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `friend-vs-${ts}-type${meta.type}-diff${
        meta.diff
      }-${randomUUID()}.html`;
      const path = join(dir, filename);

      await writeFile(path, html, "utf8");
    } catch {
      // Best-effort debug logging; ignore failures.
    }
  }

  /**
   * 更新任务状态
   */
  private async applyPatch(patch: JobPatch): Promise<Job> {
    this.job = await updateJob(this.job.id, patch);
    return this.job;
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    const interval = this.config.heartbeatIntervalMs;
    if (this.heartbeat || !Number.isFinite(interval) || interval <= 0) {
      return;
    }

    this.heartbeat = setInterval(async () => {
      try {
        this.job = await updateJob(this.job.id, { updatedAt: new Date() });
      } catch (err) {
        console.warn(`[JobHandler] Job ${this.job.id}: heartbeat failed`, err);
      }
    }, interval);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
