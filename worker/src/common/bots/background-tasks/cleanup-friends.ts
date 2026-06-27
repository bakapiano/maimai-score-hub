/**
 * 清理服务
 * 负责清理不在活跃任务列表中的好友请求和好友
 */

import type { BotManager, ManagedBot } from "../bot-manager.ts";
import {
  getActiveFriendCodes,
  getUsersActivity,
} from "../../backend/jobs.ts";
import { WORKER_DEFAULTS } from "../../config.ts";
import type { PeriodicTask } from "./index.ts";

const INACTIVE_FRIEND_EVICTION_MS = 30 * 60 * 1000;
const FRIEND_COUNT_SOFT_LIMIT = 50;

interface UserActivity {
  friendCode: string;
  lastActiveAt: string | null;
  cabinetUserId: number | null;
}

export function createCleanupFriendsTask(manager: BotManager): PeriodicTask {
  return {
    name: "CleanupService",
    intervalMs: getCleanupIntervalMs(),
    run: () => runCleanup(manager),
  };
}

export function selectInactiveFriends(params: {
  friends: string[];
  activeFriendCodes: ReadonlySet<string>;
  activityData: UserActivity[];
  nowMs?: number;
}): string[] {
  const {
    friends,
    activeFriendCodes,
    activityData,
    nowMs = Date.now(),
  } = params;
  const activityMap = new Map(activityData.map((u) => [u.friendCode, u]));
  const removals = new Set<string>();

  for (const friendCode of friends) {
    if (activeFriendCodes.has(friendCode)) continue;

    const activity = activityMap.get(friendCode);
    if (activity?.cabinetUserId != null) {
      removals.add(friendCode);
      continue;
    }

    const lastActive = activity?.lastActiveAt;
    if (!lastActive) {
      if (activityMap.has(friendCode)) {
        removals.add(friendCode);
      }
      continue;
    }

    if (isInactive(lastActive, nowMs)) {
      removals.add(friendCode);
    }
  }

  const countAfterBaseCleanup = friends.length - removals.size;
  if (countAfterBaseCleanup > FRIEND_COUNT_SOFT_LIMIT) {
    const extraRemovalCount = countAfterBaseCleanup - FRIEND_COUNT_SOFT_LIMIT;
    const overflowRemovals = friends
      .filter(
        (friendCode) =>
          !activeFriendCodes.has(friendCode) && !removals.has(friendCode),
      )
      .map((friendCode) => ({
        friendCode,
        lastActiveMs: toLastActiveMs(activityMap.get(friendCode)?.lastActiveAt),
      }))
      .filter(
        (candidate): candidate is { friendCode: string; lastActiveMs: number } =>
          candidate.lastActiveMs != null,
      )
      .sort((a, b) => a.lastActiveMs - b.lastActiveMs)
      .slice(0, extraRemovalCount);

    for (const { friendCode } of overflowRemovals) {
      removals.add(friendCode);
    }
  }

  return friends.filter((friendCode) => removals.has(friendCode));
}

function isInactive(lastActive: string, nowMs: number): boolean {
  const lastActiveMs = toLastActiveMs(lastActive);
  return (
    lastActiveMs != null &&
    nowMs - lastActiveMs > INACTIVE_FRIEND_EVICTION_MS
  );
}

function toLastActiveMs(lastActive: string | null | undefined): number | null {
  if (!lastActive) return null;
  const ms = new Date(lastActive).getTime();
  return Number.isFinite(ms) ? ms : null;
}

let cleanupRunning = false;

/**
 * 运行一次清理任务。调度周期由 worker 入口统一管理。
 */
async function runCleanup(manager: BotManager): Promise<void> {
  if (cleanupRunning) {
    console.log("[CleanupService] Cleanup already in progress, skipping");
    return;
  }

  const bot = manager.getBot();
  if (!bot || bot.expired) {
    return;
  }

  cleanupRunning = true;
  console.log("[CleanupService] Starting cleanup...");

  try {
    await cleanupForBot(bot);
    console.log("[CleanupService] Cleanup completed");
  } catch (err) {
    console.error("[CleanupService] Cleanup failed:", err);
  } finally {
    cleanupRunning = false;
  }
}

/**
 * 为单个 bot 执行清理
 */
async function cleanupForBot(bot: ManagedBot): Promise<void> {
  const botFriendCode = bot.friendCode;
  console.log(`[CleanupService] Cleaning up for bot ${botFriendCode}`);

  const client = bot.client;

  try {
    // 1. 获取当前好友请求和好友列表
    //    拉全量好友：好友上限 100，全量翻页最多约 11 页，5s spacing 下
    //    ~1 分钟。
    //    步骤 4 的「驱逐 30min inactive」必须看到全量好友才有意义 —— 之前
    //    maxPages=3 只看前 30 个，而 inactive 好友按活跃倒序沉在列表末尾，
    //    永远进不了前 30，导致好友数一路涨到上限也清不掉。
    //    getSentRequests / getAcceptRequests 本来就只 1 页，不需要分页。
    const [sentRequests, acceptRequests, friendInfos] = await Promise.all([
      client.friends.getSentRequests(),
      client.friends.getAcceptRequests(),
      client.friends.getFriendList(),
    ]);
    const friends = friendInfos.map((f) => f.friendCode);

    console.log(
      `[CleanupService] Bot ${botFriendCode} has ${sentRequests.length} sent requests, ${acceptRequests.length} accept requests and ${friends.length} friends`,
    );

    // 2. 获取活跃的 friendCode 列表
    const activeFriendCodes = await getActiveFriendCodes(botFriendCode);
    const activeSet = new Set(activeFriendCodes);

    console.log(
      `[CleanupService] Bot ${botFriendCode} has ${activeFriendCodes.length} active jobs`,
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
        await client.friends.cancelFriendRequest(req.friendCode);
      } catch (err) {
        console.error(
          `[CleanupService] Failed to cancel friend request to ${req.friendCode}:`,
          err,
        );
      }
    }

    // 4. 拒绝不在活跃列表中的待接受好友请求
    const requestsToBlock = acceptRequests.filter(
      (req) => !activeSet.has(req.friendCode),
    );
    for (const req of requestsToBlock) {
      try {
        console.log(
          `[CleanupService] Blocking friend request from ${req.friendCode}`,
        );
        await client.friends.blockFriendRequest(req.friendCode);
      } catch (err) {
        console.error(
          `[CleanupService] Failed to block friend request from ${req.friendCode}:`,
          err,
        );
      }
    }

    // 5. 清除超过 30 分钟未活跃的好友
    const friendsToRemove: string[] = [];
    {
      const activityData = await getUsersActivity(friends);

      // 淘汰不在活跃任务中的好友：
      //  - 已绑定 cabinetUserId → 驱逐，可通过 addRival 恢复
      //  - 有 lastActiveAt 且距今 > 30min → 驱逐
      //  - lastActiveAt 为 null / 无活跃记录：
      //      后端能查到该 user（注册用户但久未活跃）→ 驱逐
      //      后端查不到（bot / 刚建的号 / 非本服务用户）→ 保守保留
      //  - 上述清理后好友数仍 >50：按 lastActiveAt 从旧到新继续驱逐到 <=50
      const inactiveFriends = selectInactiveFriends({
        friends,
        activeFriendCodes: activeSet,
        activityData,
      });

      if (inactiveFriends.length > 0) {
        console.log(
          `[CleanupService] Bot ${botFriendCode} evicting ${inactiveFriends.length} inactive/abandoned friends`,
        );
        friendsToRemove.push(...inactiveFriends);
      }
    }

    for (const friendCode of friendsToRemove) {
      try {
        console.log(`[CleanupService] Removing friend ${friendCode}`);
        await client.friends.removeFriend(friendCode);
      } catch (err) {
        console.error(
          `[CleanupService] Failed to remove friend ${friendCode}:`,
          err,
        );
      }
    }

    console.log(
      `[CleanupService] Bot ${botFriendCode} cleanup done: canceled ${requestsToCancel.length} sent requests, blocked ${requestsToBlock.length} accept requests, removed ${friendsToRemove.length} friends`,
    );
  } catch (err) {
    console.error(
      `[CleanupService] Failed to cleanup for bot ${botFriendCode}:`,
      err,
    );
  }
}

function getCleanupIntervalMs(): number {
  const intervalMs = Number(
    process.env.CLEANUP_INTERVAL_MS ?? WORKER_DEFAULTS.cleanupIntervalMs,
  );

  return Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : WORKER_DEFAULTS.cleanupIntervalMs;
}
