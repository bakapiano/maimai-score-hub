import type * as http from "http";
import * as net from "net";

import {
  destroySocket,
  endSocketAndDestroy,
} from "../socket-lifecycle.ts";

export function attachClientErrorHandler(proxyServer: http.Server): void {
  proxyServer.on("clientError", handleProxyClientError);
}

function handleProxyClientError(err: Error, clientSocket: unknown): void {
  const rawPacket = (err as { rawPacket?: Buffer }).rawPacket;
  const rawPreview = rawPacket
    ? rawPacket.toString("utf8", 0, 200)
    : "<no rawPacket>";
  console.log("[Proxy] Client error: " + err);
  console.log("[Proxy] Client error raw: " + rawPreview);

  const socket = clientSocket as net.Socket;
  if (!socket.destroyed && socket.writable) {
    try {
      endSocketAndDestroy(
        socket,
        "HTTP/1.1 400 Bad Request\r\n" +
          "Content-Length: 0\r\n" +
          "Connection: close\r\n\r\n",
      );
    } catch (e) {
      console.log("[Proxy] Failed to send error response:", e);
      destroySocket(socket);
    }
  }
}
