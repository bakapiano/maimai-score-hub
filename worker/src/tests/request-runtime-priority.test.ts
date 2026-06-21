import assert from "node:assert/strict";

import { REQUEST_PRIORITY_IMMEDIATE } from "../common/maimai/infra/request-priority.ts";
import { getJobTypePriority } from "@maimai-score-hub/shared";

const friendRequestPriority = getJobTypePriority("send_friend_request");
const acceptRequestPriority = getJobTypePriority("accept_friend_request");
const updateScorePriority = getJobTypePriority("update_score");
const recentEventPriority = getJobTypePriority("get_user_recent_event");

assert.equal(friendRequestPriority, acceptRequestPriority);
assert.ok(friendRequestPriority > updateScorePriority);
assert.ok(REQUEST_PRIORITY_IMMEDIATE > friendRequestPriority);
assert.ok(updateScorePriority > recentEventPriority);

console.log("Pinned maimai request priority mapping.");
