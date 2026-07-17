import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { makeJob } from "../job-fixtures.ts";
import type { SdgbE2eHarness } from "../harness.ts";

export async function verifyLaneRouting(
  harness: SdgbE2eHarness,
): Promise<void> {
  const correctTag = `lane-correct-${randomUUID()}`;
  const wrongTag = `lane-wrong-${randomUUID()}`;
  const correct = [
    makeJob({
      id: `${correctTag}-probe`,
      jobType: "get_user_map",
      requesterTag: correctTag,
    }),
    makeJob({
      id: `${correctTag}-interactive`,
      jobType: "scan_qr",
      requesterTag: correctTag,
    }),
  ];
  const wrong = makeJob({
    id: `${wrongTag}-probe-on-interactive`,
    jobType: "get_user_map",
    requesterTag: wrongTag,
  });

  try {
    await harness.insertAndEnqueue(correct);
    await harness.enqueueOnLane(wrong, "interactive");
    const [completed, failed] = await Promise.all([
      harness.waitForJobs(correctTag, correct.length),
      harness.waitForJobs(wrongTag, 1, "failed"),
    ]);
    assert.equal(completed.length, 2);
    assert.match(
      failed[0]?.error ?? "",
      /JOB_LANE_MISMATCH:.*:interactive:probe/,
    );
  } finally {
    await Promise.all([
      harness.cleanupRequester(correctTag),
      harness.cleanupRequester(wrongTag),
    ]);
  }
}
