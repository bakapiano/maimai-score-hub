import type * as http from "http";
import * as net from "net";
import * as url from "url";

import {
  getProxyAuthHeader,
  isProxyAuthValid,
  writeConnectProxyAuthRequired,
} from "../auth.ts";
import {
  destroySocket,
  endSocketAndDestroy,
} from "../socket-lifecycle.ts";

export const PROXY_CONNECT_TIMEOUT_MS = 15_000;
export const PROXY_TUNNEL_IDLE_TIMEOUT_MS = 5 * 60_000;

export function attachConnectTunnelHandler(proxyServer: http.Server): void {
  proxyServer.on("connect", (clientReq, clientSocket, head) => {
    handleConnectRequest(clientReq, clientSocket as net.Socket, head);
  });
}

function handleConnectRequest(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
): void {
  clientSocket.on("error", (e: Error) => {
    console.log("[Proxy] Client socket error: " + e);
    destroySocket(clientSocket);
  });

  const reqUrl = url.parse("https://" + clientReq.url);

  if (!isProxyAuthValid(getProxyAuthHeader(clientReq))) {
    writeConnectProxyAuthRequired(clientSocket);
    return;
  }

  forwardConnectRequest(clientReq, clientSocket, head, reqUrl);
}

function forwardConnectRequest(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  reqUrl: url.UrlWithStringQuery,
): void {
  const options = {
    port: reqUrl.port ? parseInt(reqUrl.port, 10) : 443,
    host: reqUrl.hostname || undefined,
  };

  let established = false;
  const serverSocket = net.connect(options);

  const destroyPair = () => {
    destroySocket(clientSocket);
    destroySocket(serverSocket);
  };

  clientSocket.setTimeout(PROXY_CONNECT_TIMEOUT_MS);
  serverSocket.setTimeout(PROXY_CONNECT_TIMEOUT_MS);
  clientSocket.once("timeout", () => {
    console.log("[Proxy] Client CONNECT timed out");
    destroyPair();
  });
  serverSocket.once("timeout", () => {
    console.log("[Proxy] Upstream CONNECT timed out");
    destroyPair();
  });

  clientSocket.once("end", () => endSocketAndDestroy(serverSocket));
  serverSocket.once("end", () => endSocketAndDestroy(clientSocket));
  clientSocket.once("close", () => endSocketAndDestroy(serverSocket));
  serverSocket.once("close", () => endSocketAndDestroy(clientSocket));

  serverSocket.once("connect", () => {
    established = true;
    clientSocket.setTimeout(PROXY_TUNNEL_IDLE_TIMEOUT_MS);
    serverSocket.setTimeout(PROXY_TUNNEL_IDLE_TIMEOUT_MS);
    writeConnectionEstablished(clientReq, clientSocket, () => {
      if (clientSocket.destroyed || serverSocket.destroyed) return;
      serverSocket.write(head);
      serverSocket.pipe(clientSocket, { end: false });
      clientSocket.pipe(serverSocket, { end: false });
    });
  });

  serverSocket.on("error", (e) => {
    console.log("[Proxy] Forward proxy server connection error: " + e);
    destroySocket(serverSocket);
    if (established) {
      destroySocket(clientSocket);
      return;
    }
    endSocketAndDestroy(
      clientSocket,
      "HTTP/1.1 502 Bad Gateway\r\n" +
        "Content-Length: 0\r\n" +
        "Connection: close\r\n\r\n",
    );
  });
}

function writeConnectionEstablished(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  onEstablished: () => void,
): void {
  clientSocket.write(
    "HTTP/" +
      clientReq.httpVersion +
      " 200 Connection Established\r\n" +
      "Proxy-agent: Node.js-Proxy\r\n" +
      "\r\n",
    "utf-8",
    onEstablished,
  );
}
