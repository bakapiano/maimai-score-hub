import { timingSafeEqual } from "crypto";
import type * as http from "http";
import type * as net from "net";

import config from "../../common/config.ts";

const PROXY_AUTH_REALM = 'Basic realm="maimai-worker-proxy"';

export function getProxyAuthHeader(
  clientReq: http.IncomingMessage,
): string | undefined {
  return clientReq.headers["proxy-authorization"] as string | undefined;
}

export function isProxyAuthValid(headerValue: string | undefined): boolean {
  const expected = config.httpProxy.proxyPassword;
  if (!expected) return true;

  if (!headerValue || !headerValue.toLowerCase().startsWith("basic ")) {
    return false;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(headerValue.slice(6).trim(), "base64").toString(
      "utf8",
    );
  } catch {
    return false;
  }

  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (user !== "admin") return false;

  const a = Buffer.from(pass, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function writeHttpProxyAuthRequired(
  clientRes: http.ServerResponse,
): void {
  try {
    clientRes.writeHead(407, {
      "Proxy-Authenticate": PROXY_AUTH_REALM,
      "Content-Type": "text/plain",
      Connection: "close",
    });
    clientRes.end("407 Proxy Authentication Required\r\n");
  } catch (err) {
    console.log("[Proxy] Failed to send 407:", err);
  }
}

export function writeConnectProxyAuthRequired(clientSocket: net.Socket): void {
  try {
    clientSocket.end(
      "HTTP/1.1 407 Proxy Authentication Required\r\n" +
        `Proxy-Authenticate: ${PROXY_AUTH_REALM}\r\n` +
        "Connection: close\r\n" +
        "\r\n",
    );
  } catch (err) {
    console.log("[Proxy] Failed to send 407 on CONNECT:", err);
  }
}
