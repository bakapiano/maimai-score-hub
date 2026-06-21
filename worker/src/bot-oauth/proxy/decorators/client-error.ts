import type * as http from "http";
import * as net from "net";

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
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch (e) {
      console.log("[Proxy] Failed to send error response:", e);
    }
  }
}
