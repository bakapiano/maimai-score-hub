import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import path from "node:path";
import * as url from "node:url";

const TEST_PROXY_PASSWORD = "proxy-lifecycle-test";
process.env.HTTP_PROXY_PASSWORD = TEST_PROXY_PASSWORD;
process.env.ENV_PATH = path.join(process.cwd(), ".proxy-test-env-missing");

const { attachConnectTunnelHandler } = await import(
  "../bot-oauth/proxy/decorators/connect-tunnel.ts"
);
const { attachClientErrorHandler } = await import(
  "../bot-oauth/proxy/decorators/client-error.ts"
);
const { forwardRequestCase } = await import(
  "../bot-oauth/proxy/http/forward.ts"
);

console.log("proxy lifecycle: stubborn unauthenticated CONNECT");
await testStubbornUnauthenticatedConnectsAreReleased();
console.log("proxy lifecycle: refused upstream CONNECT");
await testUpstreamConnectFailureIsReleased();
console.log("proxy lifecycle: refused upstream HTTP");
await testHttpUpstreamFailureIsReleased();
console.log("proxy lifecycle: established tunnel cleanup");
await testEstablishedTunnelClosesBothSides();
console.log("proxy lifecycle: OAuth callback inside CONNECT");
await testOAuthCallbackInsideConnect();

console.log("Pinned proxy socket lifecycle cleanup under half-closed peers.");

async function testStubbornUnauthenticatedConnectsAreReleased(): Promise<void> {
  const fixture = await startProxyFixture();
  const clients: net.Socket[] = [];
  try {
    const responses = await Promise.all(
      Array.from({ length: 64 }, async () => {
        const result = await openStubbornConnect(fixture.port);
        clients.push(result.socket);
        return result.response;
      }),
    );

    assert.ok(
      responses.every((response) =>
        response.startsWith("HTTP/1.1 407 Proxy Authentication Required"),
      ),
    );
    await waitFor(() => fixture.sockets.size === 0);
    assert.equal(fixture.sockets.size, 0);
  } finally {
    clients.forEach((socket) => socket.destroy());
    await fixture.close();
  }
}

async function testUpstreamConnectFailureIsReleased(): Promise<void> {
  const fixture = await startProxyFixture();
  const unavailablePort = await findClosedPort();
  let client: net.Socket | null = null;
  try {
    const result = await openStubbornConnect(fixture.port, {
      target: `127.0.0.1:${unavailablePort}`,
      password: TEST_PROXY_PASSWORD,
    });
    client = result.socket;
    assert.ok(result.response.startsWith("HTTP/1.1 502 Bad Gateway"));
    await waitFor(() => fixture.sockets.size === 0);
    assert.equal(fixture.sockets.size, 0);
  } finally {
    client?.destroy();
    await fixture.close();
  }
}

async function testEstablishedTunnelClosesBothSides(): Promise<void> {
  const upstreamSockets = new Set<net.Socket>();
  const upstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await listen(upstream);
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const fixture = await startProxyFixture();
  let client: net.Socket | null = null;
  try {
    const connected = await openTunnel(
      fixture.port,
      `127.0.0.1:${upstreamAddress.port}`,
      TEST_PROXY_PASSWORD,
    );
    client = connected.socket;
    assert.ok(connected.response.startsWith("HTTP/1.1 200"));
    client.destroy();
    await waitFor(
      () => fixture.sockets.size === 0 && upstreamSockets.size === 0,
    );
    assert.equal(fixture.sockets.size, 0);
    assert.equal(upstreamSockets.size, 0);
  } finally {
    client?.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await fixture.close();
    await closeServer(upstream);
  }
}

async function testHttpUpstreamFailureIsReleased(): Promise<void> {
  const unavailablePort = await findClosedPort();
  const server = http.createServer((clientReq, clientRes) => {
    const requestUrl = clientReq.url ?? "";
    forwardRequestCase.handle({
      clientReq,
      clientRes,
      requestUrl,
      reqUrl: url.parse(requestUrl),
    });
  });
  const sockets = trackSockets(server);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let client: net.Socket | null = null;
  try {
    const result = await makeHalfOpenRequest(
      address.port,
      `GET http://127.0.0.1:${unavailablePort}/ HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${unavailablePort}\r\n\r\n`,
    );
    client = result.socket;
    assert.ok(result.response.startsWith("HTTP/1.1 502 Bad Gateway"));
    await waitFor(() => sockets.size === 0);
    assert.equal(sockets.size, 0);
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  }
}

async function testOAuthCallbackInsideConnect(): Promise<void> {
  let interceptedUrl = "";
  const fixture = await startProxyFixture({
    oauthConnectHost: "tgk-wcaime.wahlap.com:80",
    isOAuthCallbackRequest: (method, requestUrl) =>
      method === "GET" &&
      requestUrl.startsWith(
        "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback",
      ),
    onOAuthCallback: async (requestUrl) => {
      interceptedUrl = requestUrl;
      return "http://127.0.0.1:3999/";
    },
  });
  let client: net.Socket | null = null;
  try {
    const result = await requestOAuthCallbackThroughConnect(fixture.port);
    client = result.socket;
    assert.ok(result.response.startsWith("HTTP/1.1 200"));
    assert.match(result.response, /HTTP\/1\.1 302 Found/);
    assert.match(result.response, /Location: http:\/\/127\.0\.0\.1:3999\//);
    assert.equal(
      interceptedUrl,
      "http://tgk-wcaime.wahlap.com/wc_auth/oauth/callback?code=test",
    );
    await waitFor(() => fixture.sockets.size === 0);
  } finally {
    client?.destroy();
    await fixture.close();
  }
}

async function startProxyFixture(
  options: Parameters<typeof attachConnectTunnelHandler>[1] = {},
): Promise<{
  port: number;
  sockets: Set<net.Socket>;
  close: () => Promise<void>;
}> {
  // Importing the full worker proxy server also imports OAuth/BotManager and
  // its background intervals. Exercise the production CONNECT decorator on a
  // side-effect-free HTTP server so leaked sockets are the only possible
  // reason this test process would stay alive.
  const server = http.createServer();
  attachConnectTunnelHandler(server, options);
  attachClientErrorHandler(server);
  const sockets = trackSockets(server);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

function requestOAuthCallbackThroughConnect(
  port: number,
): Promise<{ socket: net.Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let response = "";
    let callbackSent = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ socket, response });
    };
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error("Timed out waiting for OAuth CONNECT callback"));
    }, 3_000);
    socket.once("connect", () => {
      const encoded = Buffer.from(`admin:${TEST_PROXY_PASSWORD}`).toString(
        "base64",
      );
      socket.write(
        "CONNECT tgk-wcaime.wahlap.com:80 HTTP/1.1\r\n" +
          "Host: tgk-wcaime.wahlap.com:80\r\n" +
          `Proxy-Authorization: Basic ${encoded}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!callbackSent && response.includes("\r\n\r\n")) {
        callbackSent = true;
        socket.write(
          "GET /wc_auth/oauth/callback?code=test HTTP/1.1\r\n" +
            "Host: tgk-wcaime.wahlap.com\r\n" +
            "Connection: close\r\n\r\n",
        );
      }
    });
    socket.once("end", () => {
      finish();
    });
    socket.once("error", (error) => {
      if (response.includes("HTTP/1.1 302 Found")) {
        finish();
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function trackSockets(server: http.Server): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function openStubbornConnect(
  port: number,
  options: { target?: string; password?: string } = {},
): Promise<{ socket: net.Socket; response: string }> {
  const target = options.target ?? "example.com:443";
  const auth = options.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`admin:${options.password}`).toString("base64")}\r\n`
    : "";
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: "127.0.0.1",
      port,
      allowHalfOpen: true,
    });
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ socket, response });
    };
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error("Timed out waiting for proxy to close CONNECT"));
    }, 3_000);
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", finish);
    socket.once("close", finish);
    socket.on("error", (error) => {
      if (response) {
        finish();
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function makeHalfOpenRequest(
  port: number,
  request: string,
): Promise<{ socket: net.Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: "127.0.0.1",
      port,
      allowHalfOpen: true,
    });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for HTTP proxy response"));
    }, 3_000);
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      clearTimeout(timer);
      resolve({ socket, response });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function openTunnel(
  port: number,
  target: string,
  password: string,
): Promise<{ socket: net.Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out establishing proxy tunnel"));
    }, 3_000);
    socket.once("connect", () => {
      const encoded = Buffer.from(`admin:${password}`).toString("base64");
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\n` +
          `Host: ${target}\r\n` +
          `Proxy-Authorization: Basic ${encoded}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      resolve({ socket, response });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function findClosedPort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

function listen(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for sockets to be released");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
