import type { BotManager, ManagedBot } from "../bot-manager.ts";

import type { FriendInfo } from "../../types.ts";
import type { PeriodicTask } from "./index.ts";
import { WORKER_DEFAULTS } from "../../config.ts";
import { postBotStatus } from "../../backend/bots.ts";

type BotStatusFriend = Omit<FriendInfo, "isFavorite">;

interface BotStatusPayload {
  friendCode: string;
  available: boolean;
  friendCount?: number;
  friends?: BotStatusFriend[];
  friendsUpdatedAt?: string;
}

const FRIEND_LIST_RECENT_MS = Number(
  process.env.BOT_FRIEND_LIST_RECENT_MS ?? 5 * 60_000,
);
const FRIEND_LIST_CHANGE_REPORT_DEBOUNCE_MS = Number(
  process.env.BOT_FRIEND_LIST_CHANGE_REPORT_DEBOUNCE_MS ?? 1_000,
);

const lastReportedSnapshotKeys = new WeakMap<BotManager, string | null>();

export function createBotStatusReportTask(manager: BotManager): PeriodicTask {
  return {
    name: "BotStatusReport",
    intervalMs: WORKER_DEFAULTS.botStatusReportIntervalMs,
    run: () => reportBotHeartbeat(manager),
    runImmediately: true,
  };
}

export function createBotFriendListRefreshTask(
  manager: BotManager,
): PeriodicTask {
  return {
    name: "BotFriendListRefresh",
    intervalMs: WORKER_DEFAULTS.botFriendListRefreshIntervalMs,
    run: () => refreshBotFriendList(manager),
    runImmediately: true,
  };
}

export function bindBotStatusChangeReportScheduler(
  manager: BotManager,
): () => void {
  let timeout: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;

  const schedule = (): void => {
    pending = true;
    if (timeout || running) return;
    timeout = setTimeout(run, FRIEND_LIST_CHANGE_REPORT_DEBOUNCE_MS);
  };

  const run = (): void => {
    timeout = null;
    if (running) return;
    running = true;
    pending = false;
    reportBotSnapshot(manager, { onlyIfSnapshotChanged: true })
      .catch((err) => {
        console.error("[BotStatusReport] Change report failed:", err);
      })
      .finally(() => {
        running = false;
        if (pending) schedule();
      });
  };

  manager.friendListSnapshots.onChanged(schedule);

  return () => {
    manager.friendListSnapshots.onChanged(null);
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
}

export async function reportBotHeartbeat(manager: BotManager): Promise<void> {
  const bot = manager.getBot();
  if (!bot) return;

  if (bot.expired) {
    if (await postStatus({ friendCode: bot.friendCode, available: false })) {
      lastReportedSnapshotKeys.set(manager, null);
    }
    return;
  }

  const snapshot = getFriendListSnapshot(manager);
  await postStatus(
    snapshot
      ? buildHeartbeatFromSnapshot(bot, snapshot)
      : { friendCode: bot.friendCode, available: true },
  );
}

export async function reportBotSnapshot(
  manager: BotManager,
  options: { onlyIfSnapshotChanged?: boolean } = {},
): Promise<void> {
  const bot = manager.getBot();
  if (!bot) return;

  if (bot.expired) {
    lastReportedSnapshotKeys.set(manager, null);
    return;
  }

  const snapshot = getFriendListSnapshot(manager);
  if (!snapshot) {
    return;
  }

  await postSnapshotStatus(manager, bot, snapshot, options);
}

export async function refreshBotFriendList(manager: BotManager): Promise<void> {
  const bot = manager.getBot();
  if (!bot || bot.expired) return;

  const snapshot = getFriendListSnapshot(manager);
  if (snapshot && isRecent(snapshot.updatedAt)) {
    return;
  }

  try {
    const list = await bot.client.friends.getFriendList();
    recordFriendList(manager, list);
    const refreshed = getFriendListSnapshot(manager) ?? {
      friends: list,
      updatedAt: new Date(),
    };
    await postSnapshotStatus(manager, bot, refreshed, {});
  } catch (err) {
    console.warn("[BotFriendListRefresh] Refresh failed:", err);
  }
}

async function postSnapshotStatus(
  manager: BotManager,
  bot: ManagedBot,
  snapshot: { friends: FriendInfo[]; updatedAt: Date },
  options: { onlyIfSnapshotChanged?: boolean },
): Promise<void> {
  const snapshotKey = getFriendCodeSetKey(snapshot.friends);
  if (
    options.onlyIfSnapshotChanged &&
    lastReportedSnapshotKeys.get(manager) === snapshotKey
  ) {
    return;
  }
  if (await postStatus(buildStatusFromSnapshot(bot, snapshot))) {
    lastReportedSnapshotKeys.set(manager, snapshotKey);
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
  manager.friendListSnapshots.replace(friends, updatedAt);
}

function getFriendListSnapshot(
  manager: BotManager,
): { friends: FriendInfo[]; updatedAt: Date } | null {
  return manager.friendListSnapshots.getSnapshot();
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

function buildHeartbeatFromSnapshot(
  bot: ManagedBot,
  snapshot: { friends: FriendInfo[]; updatedAt: Date },
): BotStatusPayload {
  return {
    friendCode: bot.friendCode,
    available: true,
    friendCount: snapshot.friends.length,
    friendsUpdatedAt: snapshot.updatedAt.toISOString(),
  };
}

function toBotStatusFriend({
  isFavorite: _isFavorite,
  ...friend
}: FriendInfo): BotStatusFriend {
  return friend;
}

async function postStatus(bot: BotStatusPayload): Promise<boolean> {
  try {
    await postBotStatus(bot);
    return true;
  } catch (err) {
    console.error("[BotStatusReport] Report error:", err);
    return false;
  }
}

function getFriendCodeSetKey(friends: FriendInfo[]): string {
  return friends
    .map((friend) => friend.friendCode)
    .sort()
    .join("\u0001");
}
