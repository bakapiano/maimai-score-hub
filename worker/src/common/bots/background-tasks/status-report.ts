import type { BotManager, ManagedBot } from "../bot-manager.ts";
import { postBotStatus } from "../../backend/bots.ts";
import { WORKER_DEFAULTS } from "../../config.ts";
import type { PeriodicTask } from "./index.ts";
import type { FriendInfo } from "../../types.ts";

type BotStatusFriend = Omit<FriendInfo, "isFavorite">;

interface BotStatusPayload {
  friendCode: string;
  available: boolean;
  friendCount?: number;
  friends?: BotStatusFriend[];
  friendsUpdatedAt?: string;
}

const FRIEND_LIST_RECENT_MS = Number(
  process.env.BOT_FRIEND_LIST_RECENT_MS ?? 60_000,
);

export function createBotStatusReportTask(manager: BotManager): PeriodicTask {
  return {
    name: "BotStatusReport",
    intervalMs: WORKER_DEFAULTS.botStatusReportIntervalMs,
    run: () => reportBotStatus(manager),
    runImmediately: true,
  };
}

export async function reportBotStatus(manager: BotManager): Promise<void> {
  const bot = manager.getBot();
  if (!bot) return;

  if (bot.expired) {
    await postStatus({ friendCode: bot.friendCode, available: false });
    return;
  }

  const snapshot = getFriendListSnapshot(manager);
  if (snapshot && isRecent(snapshot.updatedAt)) {
    await postStatus(buildStatusFromSnapshot(bot, snapshot));
    return;
  }

  try {
    const list = await bot.client.friends.getFriendList();
    recordFriendList(manager, list);
    const refreshed = getFriendListSnapshot(manager) ?? {
      friends: list,
      updatedAt: new Date(),
    };
    await postStatus(buildStatusFromSnapshot(bot, refreshed));
  } catch {
    await postStatus(
      snapshot
        ? buildStatusFromSnapshot(bot, snapshot)
        : { friendCode: bot.friendCode, available: true },
    );
  }
}

function isRecent(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() <= FRIEND_LIST_RECENT_MS;
}

function recordFriendList(
  manager: BotManager,
  friends: FriendInfo[],
  updatedAt = new Date(),
): void {
  manager.friendListSnapshot = {
    friends: friends.map((friend) => ({ ...friend })),
    updatedAt,
  };
}

function getFriendListSnapshot(
  manager: BotManager,
): { friends: FriendInfo[]; updatedAt: Date } | null {
  if (!manager.friendListSnapshot) {
    return null;
  }

  return {
    friends: manager.friendListSnapshot.friends.map((friend) => ({
      ...friend,
    })),
    updatedAt: new Date(manager.friendListSnapshot.updatedAt),
  };
}

function buildStatusFromSnapshot(
  bot: ManagedBot,
  snapshot: { friends: FriendInfo[]; updatedAt: Date },
): BotStatusPayload {
  const list = snapshot.friends;
  return {
    friendCode: bot.friendCode,
    available: true,
    friendCount: list.length,
    friendsUpdatedAt: snapshot.updatedAt.toISOString(),
    friends: list.map(toBotStatusFriend),
  };
}

function toBotStatusFriend({
  isFavorite: _isFavorite,
  ...friend
}: FriendInfo): BotStatusFriend {
  return friend;
}

async function postStatus(bot: BotStatusPayload): Promise<void> {
  try {
    await postBotStatus(bot);
  } catch (err) {
    console.error("[BotStatusReport] Report error:", err);
  }
}
