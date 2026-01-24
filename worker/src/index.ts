/**
 * 应用入口点
 * 启动所有服务
 */

import "./env.ts";

import config from "./config.ts";
import { proxy } from "./proxy.ts";
import { startServer } from "./api.ts";
import { startWorker } from "./services/index.ts";

// 全局异常处理
process.on("uncaughtException", (error) => {
  console.error("[Main] Uncaught Exception:", error);
  console.error("[Main] Stack:", error.stack);
  process.exit(1); // 退出让容器重启
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Main] Unhandled Rejection at:", promise);
  console.error("[Main] Reason:", reason);
  process.exit(1); // 退出让容器重启
});




// 启动 HTTP API 服务
startServer();

// 启动 Worker 调度器
startWorker();

// 启动 HTTP/HTTPS 代理服务
proxy.listen(config.httpProxy.port);
proxy.on("error", (error: Error) => console.log(`[Main] Proxy error ${error}`));

console.log(`[Main] V2 Proxy server listen on ${config.httpProxy.port}`);
