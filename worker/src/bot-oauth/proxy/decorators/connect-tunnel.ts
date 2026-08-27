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
const CONNECTED_HTTP_HEADER_LIMIT_BYTES = 64 * 1024;

export interface ConnectTunnelOptions {
  oauthConnectHost?: string;
  isOAuthCallbackRequest?: (method: string, requestUrl: string) => boolean;
  onOAuthCallback?: (requestUrl: string) => Promise<string>;
}

export function attachConnectTunnelHandler(
  proxyServer: http.Server,
  options: ConnectTunnelOptions = {},
): void {
  proxyServer.on("connect", (clientReq, clientSocket, head) => {
    handleConnectRequest(
      clientReq,
      clientSocket as net.Socket,
      head,
      options,
    );
  });
}

function handleConnectRequest(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  options: ConnectTunnelOptions,
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

  if (shouldInterceptOAuthConnect(clientReq.url, options)) {
    interceptOAuthConnect(clientReq, clientSocket, head, options);
    return;
  }

  forwardConnectRequest(clientReq, clientSocket, head, reqUrl);
}

function shouldInterceptOAuthConnect(
  authority: string | undefined,
  options: ConnectTunnelOptions,
): boolean {
  return Boolean(
    authority &&
      options.oauthConnectHost &&
      options.isOAuthCallbackRequest &&
      options.onOAuthCallback &&
      authority.toLowerCase() === options.oauthConnectHost.toLowerCase(),
  );
}

function interceptOAuthConnect(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  options: ConnectTunnelOptions,
): void {
  // Process-scoped TCP proxifiers wrap even plain HTTP destinations in
  // CONNECT. Parse the one OAuth callback request inside that tunnel so Bot
  // login can stay isolated from the machine-wide proxy configuration.
  let buffered = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let processing = false;

  const closeWithStatus = (status: string) => {
    endSocketAndDestroy(
      clientSocket,
      `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
  };

  const processBufferedRequest = async () => {
    if (processing) return;
    const headerEnd = buffered.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      if (buffered.length > CONNECTED_HTTP_HEADER_LIMIT_BYTES) {
        processing = true;
        closeWithStatus("431 Request Header Fields Too Large");
      }
      return;
    }

    processing = true;
    clientSocket.removeListener("data", onData);
    clientSocket.setTimeout(0);

    const headerText = buffered.subarray(0, headerEnd).toString("latin1");
    const lines = headerText.split("\r\n");
    const requestLine = /^(\S+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/.exec(
      lines[0] ?? "",
    );
    const hostLine = lines.find((line) => /^host\s*:/i.test(line));
    const host = hostLine?.replace(/^host\s*:\s*/i, "").trim();
    if (!requestLine || !host) {
      closeWithStatus("400 Bad Request");
      return;
    }

    const method = requestLine[1];
    const target = requestLine[2];
    const requestUrl = /^https?:\/\//i.test(target)
      ? target
      : `http://${host}${target.startsWith("/") ? target : `/${target}`}`;
    if (!options.isOAuthCallbackRequest?.(method, requestUrl)) {
      closeWithStatus("404 Not Found");
      return;
    }

    try {
      const redirect = await options.onOAuthCallback?.(requestUrl);
      if (!redirect) {
        closeWithStatus("502 Bad Gateway");
        return;
      }
      const safeRedirect = redirect.replace(/[\r\n]/g, "");
      endSocketAndDestroy(
        clientSocket,
        "HTTP/1.1 302 Found\r\n" +
          `Location: ${safeRedirect}\r\n` +
          "Content-Length: 0\r\n" +
          "Connection: close\r\n\r\n",
      );
    } catch (error) {
      console.error("[Proxy] OAuth CONNECT callback failed:", error);
      closeWithStatus("502 Bad Gateway");
    }
  };

  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    void processBufferedRequest();
  };

  clientSocket.setTimeout(PROXY_CONNECT_TIMEOUT_MS);
  clientSocket.once("timeout", () => {
    console.log("[Proxy] OAuth CONNECT callback timed out");
    destroySocket(clientSocket);
  });
  clientSocket.on("data", onData);
  writeConnectionEstablished(clientReq, clientSocket, () => {
    void processBufferedRequest();
    clientSocket.resume();
  });
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
