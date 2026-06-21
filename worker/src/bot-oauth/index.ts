import type { Server } from "http";

import config from "../common/config.ts";
import { startApiServer } from "./api/server.ts";
import { proxyServer } from "./proxy/server.ts";

interface BotOAuthLifecycle {
  stop(): void;
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
    stop: () => {
      closeServer(apiServer, "API server");
      closeServer(proxyServer, "proxy server");
    },
  };
}

function closeServer(server: Server, label: string): void {
  server.close((err) => {
    if (err) {
      console.error(`[BotOAuth] Failed to stop ${label}:`, err);
      return;
    }
    console.log(`[BotOAuth] Stopped ${label}`);
  });
}
