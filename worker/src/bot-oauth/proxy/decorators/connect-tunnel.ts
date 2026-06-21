import type * as http from "http";
import * as net from "net";
import * as url from "url";

import {
  getProxyAuthHeader,
  isProxyAuthValid,
  writeConnectProxyAuthRequired,
} from "../auth.ts";

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
    clientSocket.end();
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

  const serverSocket = net.connect(options, () => {
    writeConnectionEstablished(clientReq, clientSocket, () => {
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
  });

  serverSocket.on("error", (e) => {
    console.log("[Proxy] Forward proxy server connection error: " + e);
    clientSocket.end();
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
