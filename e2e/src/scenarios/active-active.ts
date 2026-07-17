import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { makeJob, type SdgbLane } from "../job-fixtures.ts";
import type { SdgbE2eHarness } from "../harness.ts";
import { sleep } from "../polling.ts";

export async function verifyActiveActiveDistribution(
  harness: SdgbE2eHarness,
): Promise<void> {
  const requesterTag = `active-active-${randomUUID()}`;
  const perLane = 10;
  await sleep(300);
  const claimedBefore = await harness.totalJobsClaimed();
  const records = [];
  for (let index = 0; index < perLane; index += 1) {
    records.push(
      makeJob({
        id: `${requesterTag}-probe-${index}`,
        jobType: "get_user_map",
        requesterTag,
      }),
      makeJob({
        id: `${requesterTag}-interactive-${index}`,
        jobType: "scan_qr",
        requesterTag,
      }),
    );
  }

  try {
    await harness.insertAndEnqueue(records);
    const completed = await harness.waitForJobs(
      requesterTag,
      records.length,
    );
    await harness.waitForTotalJobsClaimed(claimedBefore + records.length);
    assertWorkers(
      completed.filter((job) => job.lane === "probe"),
      "probe",
      [
        harness.workerIds["recoverable-a"],
        harness.workerIds["recoverable-b"],
      ],
    );
    assertWorkers(
      completed.filter((job) => job.lane === "interactive"),
      "interactive",
      [harness.workerIds["stable-a"], harness.workerIds["stable-b"]],
    );
  } finally {
    await harness.cleanupRequester(requesterTag);
  }
}

function assertWorkers(
  jobs: ReadonlyArray<{ lastWorkerId: string | null }>,
  lane: SdgbLane,
  expectedWorkers: readonly string[],
): void {
  const actual = new Set(jobs.map((job) => job.lastWorkerId));
  assert.deepEqual(
    [...actual].sort(),
    [...expectedWorkers].sort(),
    `${lane} jobs should reach every active member and no other worker`,
  );
}
