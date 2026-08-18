import assert from "node:assert/strict";

import { REQUEST_PRIORITY_IMMEDIATE } from "../common/maimai/infra/request-priority.ts";
import { getJobTypePriority } from "@maimai-score-hub/shared";

const friendRequestPriority = getJobTypePriority("send_friend_request");
const acceptRequestPriority = getJobTypePriority("accept_friend_request");
const updateScorePriority = getJobTypePriority("update_score");

assert.equal(friendRequestPriority, acceptRequestPriority);
assert.ok(friendRequestPriority > updateScorePriority);
assert.ok(REQUEST_PRIORITY_IMMEDIATE > friendRequestPriority);

console.log("Pinned maimai request priority mapping.");
