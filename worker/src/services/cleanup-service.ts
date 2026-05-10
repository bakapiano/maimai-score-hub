/**
 * 清理服务
 * 负责清理不在活跃任务列表中的好友请求和好友
 */

import {
  getActiveFriendCodes,
  getIdleUpdateFriendCodes,
  getUsersActivity,
} from "../clients/job-service-client.ts";

import { MaimaiHttpClient } from "./maimai-client.ts";
import { WORKER_DEFAULTS } from "../constants.ts";
import { cookieStore } from "./cookie-store.ts";

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
      const [sentRequests, friendInfos] = await Promise.all([
        client.getSentRequests(),
        client.getFriendList(),
      ]);
      const friends = friendInfos.map((f) => f.friendCode);

      console.log(
        `[CleanupService] Bot ${botFriendCode} has ${sentRequests.length} sent requests and ${friends.length} friends`,
      );

      // 2. 获取活跃的 friendCode 列表和闲时更新的 friendCode 列表
      const [activeFriendCodes, idleUpdateFriendCodes] = await Promise.all([
        getActiveFriendCodes(botFriendCode),
        getIdleUpdateFriendCodes(botFriendCode),
      ]);
      const activeSet = new Set(activeFriendCodes);
      const idleUpdateSet = new Set(idleUpdateFriendCodes);

      // 非闲时更新的好友数
      const nonIdleFriendCount = friends.filter(
        (fc) => !idleUpdateSet.has(fc),
      ).length;

      console.log(
        `[CleanupService] Bot ${botFriendCode} has ${activeFriendCodes.length} active jobs, ${idleUpdateFriendCodes.length} idle update friends, ${nonIdleFriendCount} non-idle friends`,
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

      // 4. 当非闲时更新好友 > 19 时，按活跃度排序，保留最活跃的 19 个，淘汰其余
      //    同时清除超过 30 分钟未活跃的用户
      let friendsToRemove: string[] = [];
      {
        const nonIdleFriends = friends.filter((fc) => !idleUpdateSet.has(fc));
        const activityData = await getUsersActivity(nonIdleFriends);
        const activityMap = new Map(
          activityData.map((u) => [u.friendCode, u.lastActiveAt]),
        );

        const THIRTY_MIN_MS = 30 * 60 * 1000;
        const nowMs = Date.now();

        // 先淘汰超过 30 分钟未活跃且不在活跃任务中的好友
        const inactiveFriends = nonIdleFriends.filter((fc) => {
          if (activeSet.has(fc)) return false;
          const lastActive = activityMap.get(fc);
          // Conservative: if backend has no activity record for this
          // friendCode (e.g. brand-new account just created via QR
          // login, or user that's never logged in), don't evict —
          // we have no evidence they're stale. The bot's hard cap
          // (top-19 by recency below) will still bound friend count.
          if (!lastActive) return false;
          return nowMs - new Date(lastActive).getTime() > THIRTY_MIN_MS;
        });

        if (inactiveFriends.length > 0) {
          console.log(
            `[CleanupService] Bot ${botFriendCode} evicting ${inactiveFriends.length} friends inactive for > 30 min`,
          );
          friendsToRemove.push(...inactiveFriends);
        }

        // 剔除已标记移除的后，如果剩余非闲时好友仍 > 19，按活跃度排序保留前 19
        const removeSet = new Set(friendsToRemove);
        const remaining = nonIdleFriends.filter((fc) => !removeSet.has(fc));
        if (remaining.length > 19) {
          remaining.sort((a, b) => {
            const ta = activityMap.get(a);
            const tb = activityMap.get(b);
            if (!ta && !tb) return 0;
            if (!ta) return 1;
            if (!tb) return -1;
            return new Date(tb).getTime() - new Date(ta).getTime();
          });
          const excess = remaining.slice(19);
          friendsToRemove.push(...excess);
          console.log(
            `[CleanupService] Bot ${botFriendCode} has ${remaining.length} remaining non-idle friends (> 19), evicting ${excess.length} least-active friends`,
          );
        }
      }

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

      // 5. 取消收藏闲时更新好友中不在活跃列表中且已收藏的好友
      const idleFriendsToUnfavorite = friendInfos.filter(
        (f) =>
          f.isFavorite &&
          idleUpdateSet.has(f.friendCode) &&
          !activeSet.has(f.friendCode),
      );
      for (const f of idleFriendsToUnfavorite) {
        try {
          console.log(
            `[CleanupService] Unfavoriting idle update friend ${f.friendCode}`,
          );
          await client.favoriteOffFriend(f.friendCode);
        } catch (err) {
          console.error(
            `[CleanupService] Failed to unfavorite friend ${f.friendCode}:`,
            err,
          );
        }
      }

      console.log(
        `[CleanupService] Bot ${botFriendCode} cleanup done: canceled ${requestsToCancel.length} requests, removed ${friendsToRemove.length} friends, unfavorited ${idleFriendsToUnfavorite.length} idle friends`,
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
