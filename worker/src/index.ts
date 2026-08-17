/**
 * 应用入口点
 * 启动所有服务
 */

import config from "./common/config.ts";
import { startBotOAuth } from "./bot-oauth/index.ts";
import { startLogger } from "./common/logger.ts";
import { startWorker, stopWorker } from "./worker/worker.ts";
import { stopBotManagerBackgroundTasks } from "./common/bots/bot-manager.ts";

const logger = startLogger({
  backendUrl: (config.jobService?.baseUrl ?? "").replace(/\/$/, ""),
  kind: "dxnet",
  workerId:
    process.env.WORKER_ID ||
    `dxnet-worker-${process.env.HOSTNAME || "unknown"}`,
});

let shuttingDown = false;
let exitCode = 0;

process.on("uncaughtException", (error) => {
  console.error("[Main] Uncaught Exception:", error);
  console.error("[Main] Stack:", error.stack);
  exitCode = 1;
  void shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Main] Unhandled Rejection at:", promise);
  console.error("[Main] Reason:", reason);
  exitCode = 1;
  void shutdown("unhandledRejection");
});

const oauth = startBotOAuth();
startWorker();

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Main] Graceful shutdown started reason=${reason}`);
  try {
    await stopWorker();
    stopBotManagerBackgroundTasks();
    await oauth.stop();
    await logger.stop();
  } catch (error) {
    exitCode = 1;
    console.error("[Main] Graceful shutdown failed:", error);
  } finally {
    process.exitCode = exitCode;
  }
}
