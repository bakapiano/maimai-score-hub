/**
 * 任务处理器
 * 负责处理单个同步任务的完整生命周期
 */

import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { Job, JobPatch, AggregatedScoreResult } from "../types/index.ts";
import { MaimaiHttpClient } from "./maimai-client.ts";
import { FriendManager } from "./friend-manager.ts";
import { ScoreAggregator } from "./score-aggregator.ts";
import { updateJob } from "../job-service-client.ts";
import { TIMEOUTS } from "../constants.ts";

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

      // 获取用户资料
      const profile = await this.client.getUserProfile(this.job.friendCode);
      if (!profile) {
        throw new Error("未找到该好友代码对应的用户，请检查好友代码是否正确!");
      }
      await this.applyPatch({ profile, updatedAt: new Date() });

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
      }
    } catch (e: unknown) {
      const error = e as Error;
      console.error(`[JobHandler] Job ${this.job.id} failed:`, error);
      await this.applyPatch({
        status: "failed",
        error: error?.message || String(error),
        updatedAt: new Date(),
      });
    } finally {
      this.stopHeartbeat();
      if (this.job.executing) {
        try {
          await this.applyPatch({ executing: false });
        } catch (releaseErr) {
          console.error(
            `[JobHandler] Job ${this.job.id}: failed to release execution flag`,
            releaseErr
          );
        }
      }
    }
  }

  /**
   * 处理发送好友请求阶段
   */
  private async handleSendRequest(): Promise<void> {
    console.log(`[JobHandler] Job ${this.job.id}: Checking friend list...`);

    if (!this.config.skipCleanUpFriend) {
      await this.friendManager.cleanUpFriend(this.job.friendCode);
    }

    console.log(`[JobHandler] Job ${this.job.id}: Sending friend request...`);
    await this.friendManager.sendFriendRequest(this.job.friendCode);
    await this.applyPatch({ stage: "wait_acceptance", updatedAt: new Date() });

    const sentRequests = await this.friendManager.getSentRequests();
    const match = sentRequests.find(
      (s) => s.friendCode === this.job.friendCode
    );

    if (!this.config.skipCleanUpFriend && !match) {
      throw new Error("发送好友请求失败");
    }

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
      const elapsed = Date.now() - this.job.createdAt.getTime();
      if (elapsed > TIMEOUTS.friendAcceptWait) {
        throw new Error("等待好友接受请求超时");
      }
      await this.applyPatch({ updatedAt: new Date() });
    }
  }

  /**
   * 处理更新成绩阶段
   */
  private async handleUpdateScore(): Promise<void> {
    if (this.job.skipUpdateScore) {
      console.log(
        `[JobHandler] Job ${this.job.id}: Skipping update_score (skipUpdateScore=true).`
      );
      await this.completeJob();
      return;
    }

    console.log(`[JobHandler] Job ${this.job.id}: Updating scores...`);

    let aggregated: AggregatedScoreResult;

    if (this.config.useMockResult) {
      console.log(
        `[JobHandler] Job ${this.job.id}: Using mock result (MOCK_RESULT_PATH=${this.config.mockResultPath}).`
      );
      aggregated = await this.loadMockResult();
    } else {
      console.log(
        `[JobHandler] Job ${this.job.id}: Fetching scores for all diffs...`
      );
      aggregated = await this.scoreAggregator.fetchAndAggregate(
        this.job.friendCode,
        {
          dumpHtml: this.config.dumpFriendVsHtml
            ? (html, meta) => this.dumpFriendVsHtml(html, meta)
            : undefined,
        }
      );

      if (this.config.dumpResultToMock) {
        await this.dumpMockResult(aggregated);
      }
    }

    await this.applyPatch({
      result: aggregated,
      status: "completed",
      error: null,
      updatedAt: new Date(),
    });

    // 清理好友关系（不等待完成）
    if (!this.config.skipCleanUpFriend) {
      this.friendManager.cleanUpFriend(this.job.friendCode).catch(() => {});
    }

    const cost = this.job.updatedAt.getTime() - this.job.createdAt.getTime();
    console.log(`[JobHandler] Job ${this.job.id}: Completed! Cost: ${cost}ms`);
  }

  /**
   * 完成任务（不更新成绩）
   */
  private async completeJob(): Promise<void> {
    await this.applyPatch({
      status: "completed",
      error: null,
      updatedAt: new Date(),
    });

    if (!this.config.skipCleanUpFriend) {
      this.friendManager.cleanUpFriend(this.job.friendCode).catch(() => {});
    }
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
    aggregated: AggregatedScoreResult
  ): Promise<void> {
    try {
      await mkdir(dirname(this.config.mockResultPath), { recursive: true });
      await writeFile(
        this.config.mockResultPath,
        JSON.stringify({ result: aggregated }, null, 2),
        "utf8"
      );
      console.log(
        `[JobHandler] Job ${this.job.id}: Dumped aggregated result to ${this.config.mockResultPath}.`
      );
    } catch (err) {
      console.warn(
        `[JobHandler] Job ${this.job.id}: Failed to dump aggregated result:`,
        err
      );
    }
  }

  /**
   * 导出 Friend VS HTML（调试用）
   */
  private async dumpFriendVsHtml(
    html: string,
    meta: { type: number; diff: number }
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
}
