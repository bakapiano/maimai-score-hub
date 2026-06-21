/**
 * 应用入口点
 * 启动所有服务
 */

import config from "./common/config.ts";
import { startBotOAuth } from "./bot-oauth/index.ts";
import { startLogger } from "./common/logger.ts";
import { startWorker } from "./worker/worker.ts";

startLogger({
  backendUrl: (config.jobService?.baseUrl ?? "").replace(/\/$/, ""),
  kind: "dxnet",
  workerId:
    process.env.WORKER_ID ||
    `dxnet-worker-${process.env.HOSTNAME || "unknown"}`,
});

process.on("uncaughtException", (error) => {
  console.error("[Main] Uncaught Exception:", error);
  console.error("[Main] Stack:", error.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Main] Unhandled Rejection at:", promise);
  console.error("[Main] Reason:", reason);
  process.exit(1);
});

startBotOAuth();
startWorker();
