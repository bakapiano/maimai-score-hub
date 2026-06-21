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

const proxyServer = http.createServer(handleHttpRequest);

attachConnectTunnelHandler(proxyServer);
attachClientErrorHandler(proxyServer);

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
