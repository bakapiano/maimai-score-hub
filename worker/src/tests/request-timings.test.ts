import assert from "node:assert/strict";
import { createServer } from "node:http";

import { CookieJar } from "tough-cookie";

import { executeMaimaiPageRequest } from "../common/maimai/infra/request-executor.ts";
import {
  runInBatch,
  runWithRequestContext,
  type RequestLogEntry,
  UNDICI_CONNECTION_LIMIT,
} from "../common/maimai/infra/request-runtime.ts";

let requestCount = 0;
const server = createServer((_, response) => {
  requestCount++;
  if (requestCount === 1) {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      setTimeout(() => response.end("slow body"), 60);
    }, 80);
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("fast body");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/timings`;
  const cookieJar = new CookieJar();
  const entries: RequestLogEntry[] = [];

  const pages = await runWithRequestContext(
    { onRequestLog: (entry) => entries.push(entry) },
    () =>
      runInBatch(
        () =>
          Promise.all([
            executeMaimaiPageRequest({ cookieJar, request: { url } }),
            executeMaimaiPageRequest({ cookieJar, request: { url } }),
          ]),
        "request-timings-test",
      ),
  );

  assert.deepEqual(
    pages.map((page) => page.body).sort(),
    ["fast body", "slow body"],
  );
  assert.ok(pages.every((page) => page.response.bodyUsed));
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.throttleWaitMs >= 0));
  assert.ok(entries.every((entry) => entry.headersReceived));
  assert.ok(
    entries.every(
      (entry) => entry.connectionLimit === UNDICI_CONNECTION_LIMIT,
    ),
  );
  assert.ok(entries.every((entry) => entry.timeoutMs > 0));
  assert.ok(entries.every((entry) => entry.attempt === 1));
  assert.ok(entries.some((entry) => entry.sessionQueueWaitMs >= 50));
  assert.ok(entries.some((entry) => entry.headersMs >= 50));
  assert.ok(entries.some((entry) => entry.bodyReadMs >= 40));
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

console.log("Pinned DXNet request phase timing instrumentation.");
