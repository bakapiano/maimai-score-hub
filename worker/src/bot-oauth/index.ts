import type { Server } from "http";

import config from "../common/config.ts";
import { startApiServer } from "./api/server.ts";
import { proxyServer } from "./proxy/server.ts";

interface BotOAuthLifecycle {
  stop(): Promise<void>;
}

export function startBotOAuth(): BotOAuthLifecycle {
  const apiServer = startApiServer();

  proxyServer.listen(config.httpProxy.port);
  proxyServer.on("error", (error: Error) =>
    console.log(`[BotOAuth] Proxy error ${error}`),
  );
  console.log(
    `[BotOAuth] HTTP/HTTPS proxy listening on port ${config.httpProxy.port}`,
  );

  return {
    stop: () =>
      Promise.all([
        closeServer(apiServer, "API server"),
        closeServer(proxyServer, "proxy server"),
      ]).then(() => undefined),
  };
}

function closeServer(server: Server, label: string): Promise<void> {
  return new Promise((resolve) => {
    server.close((err) => {
      if (err) {
        console.error(`[BotOAuth] Failed to stop ${label}:`, err);
      } else {
        console.log(`[BotOAuth] Stopped ${label}`);
      }
      resolve();
    });
  });
}
