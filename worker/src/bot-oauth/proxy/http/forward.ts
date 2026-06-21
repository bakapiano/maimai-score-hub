import * as http from "http";

import type { ProxyHttpRequestCase, ProxyHttpRequestContext } from "./index.ts";

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
  const options: http.RequestOptions = {
    hostname: reqUrl.hostname,
    port: reqUrl.port ? parseInt(reqUrl.port, 10) : undefined,
    path: reqUrl.path,
    method: clientReq.method,
    headers: clientReq.headers,
  };

  const serverConnection = http.request(options, (res) => {
    clientRes.writeHead(res.statusCode || 200, res.headers);
    res.pipe(clientRes);
  });

  serverConnection.on("error", (e) => {
    console.log("[Proxy] Server connection error: " + e);
  });

  clientReq.pipe(serverConnection);
}
