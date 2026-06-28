/**
 * 清理服务
 * 负责清理不在活跃任务列表中的好友请求和好友
 */

import type { BotManager, ManagedBot } from "../bot-manager.ts";
import {
  getActiveFriendCodes,
  getRunningQrLoginRivalNames,
  getUsersActivity,
} from "../../backend/jobs.ts";
import { WORKER_DEFAULTS } from "../../config.ts";
import type { PeriodicTask } from "./index.ts";
import type { FriendInfo } from "../../types.ts";

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
  friends: Array<Pick<FriendInfo, "friendCode" | "userName">>;
  activeFriendCodes: ReadonlySet<string>;
  protectedRivalNames?: ReadonlySet<string>;
  activityData: UserActivity[];
  nowMs?: number;
}): string[] {
  const {
    friends,
    activeFriendCodes,
    protectedRivalNames = new Set<string>(),
    activityData,
    nowMs = Date.now(),
  } = params;
  const activityMap = new Map(activityData.map((u) => [u.friendCode, u]));
  const removals = new Set<string>();

  for (const friend of friends) {
    const friendCode = friend.friendCode;
    if (activeFriendCodes.has(friendCode)) continue;
    const userName = normalizeRivalName(friend.userName);
    if (userName && protectedRivalNames.has(userName)) continue;

    const activity = activityMap.get(friendCode);
    if (activity?.cabinetUserId != null) {
      removals.add(friendCode);
      continue;
    }

    const lastActive = activity?.lastActiveAt;
    if (!lastActive) {
      removals.add(friendCode);
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
        (friend) => {
          if (
            activeFriendCodes.has(friend.friendCode) ||
            removals.has(friend.friendCode)
          ) {
            return false;
          }
          const userName = normalizeRivalName(friend.userName);
          return !userName || !protectedRivalNames.has(userName);
        },
      )
      .map((friend) => ({
        friendCode: friend.friendCode,
        lastActiveMs: toLastActiveMs(
          activityMap.get(friend.friendCode)?.lastActiveAt,
        ),
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

  return friends
    .map((friend) => friend.friendCode)
    .filter((friendCode) => removals.has(friendCode));
}

function normalizeRivalName(name: string | null | undefined): string | null {
  const normalized = name?.trim();
  return normalized ? normalized : null;
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

    // 2. 获取活跃的 friendCode 列表，以及 QR 登录慢路径中尚未解析出
    // friendCode 的玩家名。后者需要按 name 暂时保护，否则刚加上的好友
    // 可能在快照刷新前被 cleanup 删掉。
    const [activeFriendCodes, runningRivalNames] = await Promise.all([
      getActiveFriendCodes(botFriendCode),
      getRunningQrLoginRivalNames(),
    ]);
    const activeSet = new Set(activeFriendCodes);
    const protectedRivalNameSet = new Set(
      runningRivalNames
        .map((name) => normalizeRivalName(name))
        .filter((name): name is string => Boolean(name)),
    );

    console.log(
      `[CleanupService] Bot ${botFriendCode} has ${activeFriendCodes.length} active jobs and ${protectedRivalNameSet.size} running QR-login names`,
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

      // 淘汰不在活跃任务 / QR 登录保护名中的好友：
      //  - friend name 命中正在 QR 登录的 rivalName → 保留（此时可能还没有 friendCode）
      //  - 已绑定 cabinetUserId → 驱逐，可通过 addRival 恢复
      //  - 有 lastActiveAt 且距今 > 30min → 驱逐
      //  - lastActiveAt 为 null / 无活跃记录：
      //      后端能查到该 user（注册用户但久未活跃）→ 驱逐
      //      后端查不到 → 驱逐
      //  - 上述清理后好友数仍 >50：按 lastActiveAt 从旧到新继续驱逐到 <=50
      const inactiveFriends = selectInactiveFriends({
        friends: friendInfos,
        activeFriendCodes: activeSet,
        protectedRivalNames: protectedRivalNameSet,
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
