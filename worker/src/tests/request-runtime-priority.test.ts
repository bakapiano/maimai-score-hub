import assert from "node:assert/strict";

import { REQUEST_PRIORITY_IMMEDIATE } from "../common/maimai/infra/request-priority.ts";
import { RequestConcurrencyGate } from "../common/maimai/infra/request-concurrency-gate.ts";
import { getJobTypePriority } from "@maimai-score-hub/shared";

const friendRequestPriority = getJobTypePriority("send_friend_request");
const acceptRequestPriority = getJobTypePriority("accept_friend_request");
const updateScorePriority = getJobTypePriority("update_score");

assert.equal(friendRequestPriority, acceptRequestPriority);
assert.ok(friendRequestPriority > updateScorePriority);
assert.ok(REQUEST_PRIORITY_IMMEDIATE > friendRequestPriority);

const gate = new RequestConcurrencyGate(1);
const releaseFirst = await gate.acquire(0);
const order: string[] = [];
const low = gate.acquire(0).then((release) => {
  order.push("low");
  release();
});
const high = gate.acquire(REQUEST_PRIORITY_IMMEDIATE).then((release) => {
  order.push("high");
  release();
});
releaseFirst();
await Promise.all([low, high]);
assert.deepEqual(order, ["high", "low"]);

console.log("Pinned maimai request priority mapping.");
