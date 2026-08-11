import * as http from "http";
import * as url from "url";

import { attachClientErrorHandler } from "./decorators/client-error.ts";
import { attachConnectTunnelHandler } from "./decorators/connect-tunnel.ts";
import {
  getProxyAuthHeader,
  isProxyAuthValid,
  writeHttpProxyAuthRequired,
} from "./auth.ts";
import {
  findHttpRequestCase,
  type ProxyHttpRequestContext,
} from "./http/index.ts";
import { destroySocket } from "./socket-lifecycle.ts";

export const PROXY_HTTP_IDLE_TIMEOUT_MS = 60_000;

export function createProxyServer(): http.Server {
  const server = http.createServer(handleHttpRequest);

  server.keepAliveTimeout = 15_000;
  server.headersTimeout = 20_000;
  server.requestTimeout = PROXY_HTTP_IDLE_TIMEOUT_MS;
  server.setTimeout(PROXY_HTTP_IDLE_TIMEOUT_MS, (socket) =>
    destroySocket(socket),
  );

  attachConnectTunnelHandler(server);
  attachClientErrorHandler(server);
  return server;
}

const proxyServer = createProxyServer();

export { proxyServer };

async function handleHttpRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): Promise<void> {
  clientReq.on("error", (e: Error) => {
    console.log("[Proxy] Client socket error: " + e);
  });

  const requestUrl = clientReq.url || "";
  const ctx: ProxyHttpRequestContext = {
    clientReq,
    clientRes,
    requestUrl,
    reqUrl: url.parse(requestUrl),
  };

  if (!isProxyAuthValid(getProxyAuthHeader(clientReq))) {
    writeHttpProxyAuthRequired(clientRes);
    return;
  }

  const requestCase = findHttpRequestCase(ctx);
  await requestCase.handle(ctx);
}
