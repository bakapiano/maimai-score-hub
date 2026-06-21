import type { BotManager } from "../bot-manager.ts";
import { WORKER_DEFAULTS } from "../../config.ts";
import { CookieExpiredError } from "../../maimai/infra/errors.ts";
import type { PeriodicTask } from "./index.ts";

export function createHealthCheckTask(
  manager: BotManager,
): PeriodicTask {
  return {
    name: "BotHealthCheck",
    intervalMs: WORKER_DEFAULTS.cookieHealthCheckIntervalMs,
    run: () => checkBotHealth(manager),
    runImmediately: true,
  };
}

async function checkBotHealth(manager: BotManager): Promise<void> {
  const bot = manager.getBot();
  if (!bot) return;

  try {
    await bot.client.sessions.verifySession();
    manager._markValid();
    console.log(`[BotHealthCheck] Bot ${bot.friendCode} available`);
  } catch (err) {
    if (err instanceof CookieExpiredError) {
      console.warn(`[BotHealthCheck] Bot ${bot.friendCode} expired`);
      return;
    }

    console.error(`[BotHealthCheck] Error for bot ${bot.friendCode}:`, err);
  }
}
