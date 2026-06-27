import assert from "node:assert/strict";

import { selectInactiveFriends } from "../common/bots/background-tasks/cleanup-friends.ts";

const nowMs = new Date("2026-06-27T00:00:00.000Z").getTime();
const minutesAgo = (minutes: number) =>
  new Date(nowMs - minutes * 60_000).toISOString();

assert.deepEqual(
  selectInactiveFriends({
    friends: [
      "active",
      "cabinet-bound",
      "recent",
      "old",
      "registered-null",
      "unknown",
    ],
    activeFriendCodes: new Set(["active"]),
    activityData: [
      {
        friendCode: "active",
        lastActiveAt: minutesAgo(60),
        cabinetUserId: 1001,
      },
      {
        friendCode: "cabinet-bound",
        lastActiveAt: minutesAgo(1),
        cabinetUserId: 1002,
      },
      { friendCode: "recent", lastActiveAt: minutesAgo(5), cabinetUserId: null },
      { friendCode: "old", lastActiveAt: minutesAgo(31), cabinetUserId: null },
      {
        friendCode: "registered-null",
        lastActiveAt: null,
        cabinetUserId: null,
      },
    ],
    nowMs,
  }),
  ["cabinet-bound", "old", "registered-null"],
);

{
  const friends = Array.from({ length: 55 }, (_, index) => `user-${index}`);
  const activityData = friends.map((friendCode, index) => ({
    friendCode,
    lastActiveAt: new Date(nowMs - (29 * 60_000 - index * 1_000)).toISOString(),
    cabinetUserId: null,
  }));

  assert.deepEqual(
    selectInactiveFriends({
      friends,
      activeFriendCodes: new Set(),
      activityData,
      nowMs,
    }),
    ["user-0", "user-1", "user-2", "user-3", "user-4"],
  );
}

console.log("Cleanup friend selection rules passed.");
