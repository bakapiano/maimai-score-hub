import assert from "node:assert/strict";
import test from "node:test";

import type { Job, JobPatch } from "../common/types.ts";
import type { JobExecutionContext } from "../worker/jobs/handlers/index.ts";
import { getUserRecentEventJobHandler } from "../worker/jobs/handlers/get-user-recent-event/index.ts";
import { updateScoreJobHandler } from "../worker/jobs/handlers/update-score/index.ts";

test("recent-event shared claim hands off to the pinned delivery", async () => {
  const harness = createHarness({
    jobType: "get_user_recent_event",
    deliveryMode: "shared",
  });

  assert.equal(
    await getUserRecentEventJobHandler.preflight?.(harness.ctx),
    "complete_delivery",
  );
  assert.equal(harness.patches[0]?.handoff?.deliveryMode, "pinned");
  assert.equal(harness.patches[0]?.status, "queued");
  assert.equal(harness.ctx.job.routing?.deliveryMode, "pinned");
  assert.equal(harness.ctx.job.routing?.deliveryEpoch, 2);
  assert.equal(harness.friendChecks, 0);
});

test("update-score claim verifies friendship before scraping", async () => {
  const harness = createHarness({
    jobType: "update_score",
    deliveryMode: "shared",
    isFriend: false,
  });

  assert.equal(
    await updateScoreJobHandler.preflight?.(harness.ctx),
    "complete_delivery",
  );
  assert.equal(harness.friendChecks, 3);
  assert.deepEqual(harness.sleeps, [2_000, 5_000]);
  assert.equal(
    harness.patches.at(-1)?.errorCode,
    "cabinet_friendship_unconfirmed",
  );
  assert.equal(harness.ctx.job.status, "failed");
});

test("update-score claim continues once friendship is visible", async () => {
  const harness = createHarness({
    jobType: "update_score",
    deliveryMode: "shared",
    isFriend: true,
  });

  assert.equal(
    await updateScoreJobHandler.preflight?.(harness.ctx),
    "continue",
  );
  assert.equal(harness.friendChecks, 1);
  assert.deepEqual(harness.sleeps, []);
  assert.deepEqual(harness.patches, []);
});

test("pinned cabinet fallback also verifies the prepared friendship", async () => {
  const harness = createHarness({
    jobType: "update_score",
    deliveryMode: "pinned",
    assignmentMode: "pinned",
    cabinetFriendshipStatus: "ready",
    isFriend: false,
  });

  assert.equal(
    await updateScoreJobHandler.preflight?.(harness.ctx),
    "complete_delivery",
  );
  assert.equal(
    harness.patches.at(-1)?.errorCode,
    "cabinet_friendship_unconfirmed",
  );
});

test("recent-event pinned claim rejects an unconfirmed friendship", async () => {
  const harness = createHarness({
    jobType: "get_user_recent_event",
    deliveryMode: "pinned",
    isFriend: false,
  });

  assert.equal(
    await getUserRecentEventJobHandler.preflight?.(harness.ctx),
    "complete_delivery",
  );
  assert.equal(harness.friendChecks, 1);
  assert.equal(
    harness.patches.at(-1)?.errorCode,
    "cabinet_friendship_unconfirmed",
  );
  assert.equal(harness.ctx.job.status, "failed");
});

function createHarness(input: {
  jobType: "update_score" | "get_user_recent_event";
  deliveryMode: "shared" | "pinned";
  assignmentMode?: "claim" | "pinned";
  cabinetFriendshipStatus?: Job["cabinetFriendshipStatus"];
  isFriend?: boolean;
}) {
  const patches: JobPatch[] = [];
  const sleeps: number[] = [];
  let friendChecks = 0;
  const job = {
    id: "preflight-job",
    friendCode: "123456789012345",
    jobType: input.jobType,
    status: "processing",
    stage: input.jobType,
    routing: {
      version: 2,
      deliveryEpoch: 1,
      source: input.jobType === "update_score" ? "user_sync" : "auto_update",
      lane: input.jobType === "update_score" ? "user_sync" : "background",
      assignmentMode: input.assignmentMode ?? "claim",
      deliveryMode: input.deliveryMode,
    },
    cabinetFriendshipStatus: input.cabinetFriendshipStatus,
  } as Job;

  const applyPatch = async (patch: JobPatch): Promise<Job> => {
    patches.push(patch);
    const { handoff, ...fields } = patch;
    Object.assign(job, fields);
    if (handoff && job.routing) {
      job.routing = {
        ...job.routing,
        deliveryMode: handoff.deliveryMode,
        deliveryEpoch: job.routing.deliveryEpoch + 1,
      };
      job.status = "queued";
      job.runAt = new Date(handoff.runAt);
    }
    return job;
  };
  const ctx = {
    job,
    client: {
      friends: {
        isFriend: async () => {
          friendChecks += 1;
          return input.isFriend ?? true;
        },
      },
    },
    applyPatch,
    transitionTo: async () => job,
    delay: async () => job,
    fail: async (error: string, patch: JobPatch = {}) => {
      const next = {
        ...patch,
        status: "failed" as const,
        error,
        runAt: null,
      };
      await applyPatch(next);
      return job;
    },
    completeJob: async () => undefined,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  } as unknown as JobExecutionContext;

  return {
    ctx,
    patches,
    sleeps,
    get friendChecks() {
      return friendChecks;
    },
  };
}
