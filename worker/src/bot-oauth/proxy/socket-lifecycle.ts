import type * as http from "node:http";
import type * as net from "node:net";

/**
 * `socket.end()` only half-closes a TCP connection. If the peer never sends
 * its FIN, Node keeps the descriptor in FIN-WAIT-2 indefinitely. Give the
 * response a short opportunity to flush, then always release the descriptor.
 */
export const PROXY_SOCKET_CLOSE_GRACE_MS = 1_000;
const PROXY_SOCKET_RESET_AFTER_WRITE_MS = 500;

const forcedDestroyTimers = new WeakMap<net.Socket, NodeJS.Timeout>();

export function destroySocket(socket: net.Socket | null | undefined): void {
  if (socket && !socket.destroyed) {
    socket.destroy();
  }
}

export function endSocketAndDestroy(
  socket: net.Socket,
  payload?: string | Buffer,
): void {
  if (socket.destroyed) return;
  if (!socket.writable) {
    destroySocket(socket);
    return;
  }

  if (forcedDestroyTimers.has(socket)) return;
  armForcedDestroy(socket);
  if (socket.writableEnded) return;

  try {
    if (payload !== undefined) {
      // CONNECT sockets are detached from Node's HTTP lifecycle. Sending FIN
      // here lets a peer that never closes strand the kernel in FIN-WAIT-2.
      // Flush the complete error response, then reset only this failed tunnel.
      socket.write(payload, () => {
        const resetTimer = setTimeout(
          () => resetAndDestroySocket(socket),
          PROXY_SOCKET_RESET_AFTER_WRITE_MS,
        );
        resetTimer.unref();
      });
      return;
    }

    socket.end(() => destroySocket(socket));
  } catch {
    resetAndDestroySocket(socket);
  }
}

export function endHttpResponseAndDestroy(
  response: http.ServerResponse,
  payload?: string | Buffer,
): void {
  const socket = response.socket;
  response.shouldKeepAlive = false;

  if (!socket) {
    response.end(payload);
    return;
  }

  if (forcedDestroyTimers.has(socket)) return;
  armForcedDestroy(socket);
  try {
    const destroyAfterFlush = () => destroySocket(socket);
    if (payload === undefined) {
      response.end(destroyAfterFlush);
    } else {
      response.end(payload, destroyAfterFlush);
    }
  } catch {
    resetAndDestroySocket(socket);
  }
}

function armForcedDestroy(socket: net.Socket): void {
  if (forcedDestroyTimers.has(socket)) return;

  const timer = setTimeout(
    () => resetAndDestroySocket(socket),
    PROXY_SOCKET_CLOSE_GRACE_MS,
  );
  timer.unref();
  forcedDestroyTimers.set(socket, timer);
  socket.once("close", () => {
    clearTimeout(timer);
    forcedDestroyTimers.delete(socket);
  });
}

function resetAndDestroySocket(socket: net.Socket): void {
  if (socket.destroyed) return;
  try {
    // Node 18+ sends an RST and immediately drops the kernel TCP state. This
    // is only used after the graceful response window elapsed; normal peers
    // still complete the FIN handshake without a reset.
    socket.resetAndDestroy();
  } catch {
    socket.destroy();
  }
}
