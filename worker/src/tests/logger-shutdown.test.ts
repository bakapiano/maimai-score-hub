import assert from "node:assert/strict";
import test from "node:test";

import { startLogger } from "../common/logger.ts";

test("logger stop drains once without recapturing transport warnings", async () => {
  let calls = 0;
  const logger = startLogger({
    backendUrl: "http://127.0.0.1",
    kind: "dxnet",
    workerId: "logger-test",
    flushIntervalMs: 60_000,
    sendBatch: async () => {
      calls += 1;
      console.warn("transport unavailable");
      throw new Error("transport unavailable");
    },
  });

  console.log("shutdown log");
  await logger.stop();

  assert.equal(calls, 1);
});
