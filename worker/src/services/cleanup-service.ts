/**
 * 清理服务
 * 负责清理不在活跃任务列表中的好友请求和好友
 */

import { MaimaiHttpClient } from "./maimai-client.ts";
import { WORKER_DEFAULTS } from "../constants.ts";
import { cookieStore } from "./cookie-store.ts";
import { getActiveFriendCodes, getIdleUpdateFriendCodes } from "../job-service-client.ts";

/**
 * 清理服务类
 */
export class CleanupService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private onPauseRequest: (() => void) | null = null;
  private onResumeRequest: (() => void) | null = null;

  /**
   * 设置暂停/恢复回调
   */
  setCallbacks(onPause: () => void, onResume: () => void): void {
    this.onPauseRequest = onPause;
    this.onResumeRequest = onResume;
  }

  /**
   * 启动清理服务
   */
  start(): void {
    if (this.intervalId) {
      return;
    }

    const cleanupIntervalMs = Number(
      process.env.CLEANUP_INTERVAL_MS ?? WORKER_DEFAULTS.cleanupIntervalMs,
    );

    this.intervalId = setInterval(() => this.runCleanup(), cleanupIntervalMs);

    console.log(
      `[CleanupService] Started with interval ${cleanupIntervalMs}ms`,
    );
  }

  /**
   * 停止清理服务
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[CleanupService] Stopped");
    }
  }

  /**
   * 运行清理任务
   */
  async runCleanup(): Promise<void> {
    if (this.isRunning) {
      console.log("[CleanupService] Cleanup already in progress, skipping");
      return;
    }

    const availableBots = cookieStore.getAllBotFriendCodes();
    if (!availableBots.length) {
      return;
    }

    this.isRunning = true;

    // 请求暂停 job claiming
    if (this.onPauseRequest) {
      this.onPauseRequest();
    }
    console.log("[CleanupService] Starting cleanup, pausing job claiming...");

    try {
      // 对每个 bot 执行清理
      for (const botFriendCode of availableBots) {
        await this.cleanupForBot(botFriendCode);
      }

      console.log("[CleanupService] Cleanup completed");
    } catch (err) {
      console.error("[CleanupService] Cleanup failed:", err);
    } finally {
      this.isRunning = false;
      // 请求恢复 job claiming
      if (this.onResumeRequest) {
        this.onResumeRequest();
      }
      console.log("[CleanupService] Resuming job claiming...");
    }
  }

  /**
   * 为单个 bot 执行清理
   */
  private async cleanupForBot(botFriendCode: string): Promise<void> {
    console.log(`[CleanupService] Cleaning up for bot ${botFriendCode}`);

    const cookieJar = cookieStore.get(botFriendCode);
    if (!cookieJar) {
      console.log(
        `[CleanupService] Bot ${botFriendCode} cookie not found, skipping`,
      );
      return;
    }

    const client = new MaimaiHttpClient(cookieJar);

    try {
      // 1. 获取当前已发送的好友请求和好友列表
      const [sentRequests, friends] = await Promise.all([
        client.getSentRequests(),
        client.getFriendList(),
      ]);

      console.log(
        `[CleanupService] Bot ${botFriendCode} has ${sentRequests.length} sent requests and ${friends.length} friends`,
      );

      // 2. 获取活跃的 friendCode 列表和闲时更新的 friendCode 列表
      const [activeFriendCodes, idleUpdateFriendCodes] = await Promise.all([
        getActiveFriendCodes(botFriendCode),
        getIdleUpdateFriendCodes(botFriendCode).catch(() => [] as string[]),
      ]);
      const activeSet = new Set(activeFriendCodes);
      const idleUpdateSet = new Set(idleUpdateFriendCodes);

      console.log(
        `[CleanupService] Bot ${botFriendCode} has ${activeFriendCodes.length} active jobs, ${idleUpdateFriendCodes.length} idle update friends`,
      );

      // 3. 取消不在活跃列表中的好友请求（好友请求仍然定期清理）
      const requestsToCancel = sentRequests.filter(
        (req) => !activeSet.has(req.friendCode),
      );
      for (const req of requestsToCancel) {
        try {
          console.log(
            `[CleanupService] Canceling friend request to ${req.friendCode}`,
          );
          await client.cancelFriendRequest(req.friendCode);
        } catch (err) {
          console.error(
            `[CleanupService] Failed to cancel friend request to ${req.friendCode}:`,
            err,
          );
        }
      }

      // 4. 删除不在活跃列表中且不在闲时更新列表中的好友
      const friendsToRemove = friends.filter(
        (friendCode) =>
          !activeSet.has(friendCode) && !idleUpdateSet.has(friendCode),
      );
      for (const friendCode of friendsToRemove) {
        try {
          console.log(`[CleanupService] Removing friend ${friendCode}`);
          await client.removeFriend(friendCode);
        } catch (err) {
          console.error(
            `[CleanupService] Failed to remove friend ${friendCode}:`,
            err,
          );
        }
      }

      console.log(
        `[CleanupService] Bot ${botFriendCode} cleanup done: canceled ${requestsToCancel.length} requests, removed ${friendsToRemove.length} friends`,
      );
    } catch (err) {
      console.error(
        `[CleanupService] Failed to cleanup for bot ${botFriendCode}:`,
        err,
      );
    }
  }
}

// 默认导出单例实例
export const cleanupService = new CleanupService();
