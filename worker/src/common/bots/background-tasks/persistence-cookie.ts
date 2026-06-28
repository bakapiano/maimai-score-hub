import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CookieJar, type SerializedCookieJar } from "tough-cookie";

import type { BotManager } from "../bot-manager.ts";
import type { PeriodicTask } from "./index.ts";

const SAVE_DEBOUNCE_MS = 1000;
const saveTimers = new WeakMap<BotManager, ReturnType<typeof setTimeout>>();
const persistPath = process.env.COOKIE_PERSIST_PATH || "./data/cookies.json";

interface PersistedBot {
  friendCode: string;
  jar: SerializedCookieJar;
  expired: boolean;
}

interface PersistedDataV2 {
  version: 2;
  updatedAt: string;
  bot: PersistedBot | null;
}

type BotSnapshot = {
  friendCode: string;
  cookieJar: CookieJar;
  expired: boolean;
};

export function loadPersistedBot(manager: BotManager): number {
  console.log(`[BotPersistence] Persistence enabled: ${persistPath}`);

  if (!existsSync(persistPath)) {
    console.log(`[BotPersistence] No persisted data found at ${persistPath}`);
    return 0;
  }

  try {
    const raw = readFileSync(persistPath, "utf-8");
    const data: PersistedDataV2 = JSON.parse(raw);
    const persistedBot = data.version === 2 ? data.bot : null;
    if (!persistedBot) {
      restoreBotSnapshot(manager, null);
      console.log("[BotPersistence] No persisted bot cookie found");
      return 0;
    }

    restoreBotSnapshot(manager, {
      friendCode: persistedBot.friendCode,
      cookieJar: CookieJar.deserializeSync(persistedBot.jar),
      expired: persistedBot.expired,
    });

    console.log(
      `[BotPersistence] Restored bot cookie for ${persistedBot.friendCode} from disk (saved at ${data.updatedAt})`,
    );
    return 1;
  } catch (err) {
    console.warn("[BotPersistence] Failed to load persisted data:", err);
    return 0;
  }
}

export function bindBotSaveScheduler(manager: BotManager): () => void {
  const unsubscribe = manager.onStateChanged(() => {
    scheduleBotSave(manager);
  });

  return () => {
    unsubscribe();
    flushScheduledBotSave(manager);
  };
}

export function createBotPeriodicSaveTask(manager: BotManager): PeriodicTask {
  return {
    name: "BotPeriodicSave",
    intervalMs: getPeriodicSaveIntervalMs(),
    run: async () => {
      saveBotToDisk(manager);
    },
  };
}

function scheduleBotSave(manager: BotManager): void {
  const existing = saveTimers.get(manager);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    saveBotToDisk(manager);
    saveTimers.delete(manager);
  }, SAVE_DEBOUNCE_MS);
  timer.unref?.();

  saveTimers.set(manager, timer);
}

function flushScheduledBotSave(manager: BotManager): void {
  const existing = saveTimers.get(manager);
  if (!existing) return;

  clearTimeout(existing);
  saveTimers.delete(manager);
  saveBotToDisk(manager);
}

function saveBotToDisk(manager: BotManager): void {
  try {
    const dir = dirname(persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const data: PersistedDataV2 = {
      version: 2,
      updatedAt: new Date().toISOString(),
      bot: serializeBot(getBotSnapshot(manager)),
    };

    writeFileSync(persistPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[BotPersistence] Failed to save cookies to disk:", err);
  }
}

function getBotSnapshot(manager: BotManager): BotSnapshot | null {
  if (!manager.friendCode || !manager.jar) {
    return null;
  }

  return {
    friendCode: manager.friendCode,
    cookieJar: manager.jar,
    expired: manager.expired,
  };
}

function restoreBotSnapshot(
  manager: BotManager,
  snapshot: BotSnapshot | null,
): void {
  if (!snapshot) {
    manager.friendCode = null;
    manager.jar = null;
    manager.expired = false;
    manager.friendListSnapshots.clear();
    return;
  }

  manager.friendCode = snapshot.friendCode;
  manager.jar = snapshot.cookieJar;
  manager.expired = snapshot.expired;
  manager.friendListSnapshots.clear();
}

function serializeBot(snapshot: BotSnapshot | null): PersistedBot | null {
  if (!snapshot) {
    return null;
  }

  const jar = snapshot.cookieJar.serializeSync();
  if (!jar) {
    return null;
  }

  return {
    friendCode: snapshot.friendCode,
    jar,
    expired: snapshot.expired,
  };
}

function getPeriodicSaveIntervalMs(): number {
  const intervalMs = Number(process.env.COOKIE_PERIODIC_SAVE_MS ?? 30_000);
  return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000;
}
