import assert from "node:assert/strict";
import test from "node:test";

import { getDxnetLaneConcurrency } from "../common/bullmq.ts";

test("DXNet queues use the unified 8/16/16 concurrency defaults", () => {
  const names = [
    "DXNET_LANE_INTERACTIVE_CONCURRENCY",
    "DXNET_LANE_USER_SYNC_CONCURRENCY",
    "DXNET_LANE_BACKGROUND_CONCURRENCY",
  ] as const;
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    assert.equal(getDxnetLaneConcurrency("interactive"), 8);
    assert.equal(getDxnetLaneConcurrency("user_sync"), 16);
    assert.equal(getDxnetLaneConcurrency("background"), 16);
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});
