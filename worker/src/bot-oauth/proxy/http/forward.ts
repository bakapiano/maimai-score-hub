import * as http from "http";

import type { ProxyHttpRequestCase, ProxyHttpRequestContext } from "./index.ts";
import {
  destroySocket,
  endHttpResponseAndDestroy,
} from "../socket-lifecycle.ts";

const PROXY_HTTP_UPSTREAM_TIMEOUT_MS = 30_000;

export const forwardRequestCase: ProxyHttpRequestCase = {
  name: "forward",
  matches: () => true,
  handle: forwardHttpRequest,
};

function forwardHttpRequest({
  clientReq,
  clientRes,
  reqUrl,
}: ProxyHttpRequestContext): void {
  const headers = { ...clientReq.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];

  const options: http.RequestOptions = {
    hostname: reqUrl.hostname,
    port: reqUrl.port ? parseInt(reqUrl.port, 10) : undefined,
    path: reqUrl.path,
    method: clientReq.method,
    headers,
  };

  let upstreamResponse: http.IncomingMessage | null = null;
  const serverConnection = http.request(options, (res) => {
    upstreamResponse = res;
    clientRes.writeHead(res.statusCode || 200, res.headers);
    res.once("error", () => destroySocket(clientRes.socket));
    res.pipe(clientRes);
  });

  serverConnection.setTimeout(PROXY_HTTP_UPSTREAM_TIMEOUT_MS, () => {
    serverConnection.destroy(new Error("HTTP proxy upstream timed out"));
  });
  serverConnection.on("error", (e) => {
    console.log("[Proxy] Server connection error: " + e);
    if (clientRes.destroyed || clientRes.writableEnded) return;
    if (clientRes.headersSent) {
      destroySocket(clientRes.socket);
      return;
    }
    clientRes.writeHead(502, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    endHttpResponseAndDestroy(clientRes, "502 Bad Gateway\r\n");
  });

  clientReq.once("aborted", () => serverConnection.destroy());
  clientReq.once("error", () => serverConnection.destroy());
  clientRes.once("close", () => {
    serverConnection.destroy();
    upstreamResponse?.destroy();
  });

  clientReq.pipe(serverConnection);
}
