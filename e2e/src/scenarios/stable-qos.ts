import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { makeJob } from "../job-fixtures.ts";
import type { SdgbE2eHarness } from "../harness.ts";
import { sleep } from "../polling.ts";

export async function verifyStableFailoverQos(
  harness: SdgbE2eHarness,
): Promise<void> {
  const stableA = harness.workerIds["stable-a"];
  const ceilingTag = `stable-global-${randomUUID()}`;
  const backlogTag = `stable-probe-backlog-${randomUUID()}`;
  const interactiveTag = `stable-priority-${randomUUID()}`;
  try {
    await harness.killWorker("stable-b");
    await harness.waitForActiveMembers("interactive", [stableA]);

    const ceilingJobs = [
      makeJob({
        id: `${ceilingTag}-scan`,
        jobType: "scan_qr",
        requesterTag: ceilingTag,
      }),
      makeJob({
        id: `${ceilingTag}-add`,
        jobType: "add_rival",
        requesterTag: ceilingTag,
      }),
    ];
    await harness.insertAndEnqueue(ceilingJobs);
    const ceilingCompleted = await harness.waitForJobs(ceilingTag, 2);
    const completionTimes = ceilingCompleted
      .map((job) => job.updatedAt.getTime())
      .sort((left, right) => left - right);
    const rootSpacingMs = completionTimes[1]! - completionTimes[0]!;
    assert.ok(
      rootSpacingMs >= 500,
      `Stable root limiter spacing was only ${rootSpacingMs}ms`,
    );
    assert.ok(
      ceilingCompleted.every((job) => job.lastWorkerId === stableA),
    );

    await harness.killWorker("recoverable-a");
    await harness.killWorker("recoverable-b");
    await harness.waitForActiveMembers("probe", [stableA]);

    const backlog = Array.from({ length: 8 }, (_, index) =>
      makeJob({
        id: `${backlogTag}-${index}`,
        jobType: index % 2 === 0 ? "get_user_map" : "get_rival_hash",
        requesterTag: backlogTag,
      }),
    );
    await harness.insertAndEnqueue(backlog);
    await harness.waitForWorkerActiveJobs(stableA, 4);
    await sleep(100);

    const interactive = makeJob({
      id: `${interactiveTag}-scan`,
      jobType: "scan_qr",
      requesterTag: interactiveTag,
    });
    const enqueuedAt = Date.now();
    await harness.insertAndEnqueue([interactive]);
    const [completed] = await harness.waitForJobs(interactiveTag, 1);
    const latencyMs = completed!.updatedAt.getTime() - enqueuedAt;
    assert.equal(completed?.lastWorkerId, stableA);
    assert.ok(
      latencyMs <= 1_500,
      `Interactive waited ${latencyMs}ms behind failover Probe backlog`,
    );
    await harness.waitForJobs(backlogTag, backlog.length, "completed", 30_000);
  } finally {
    await Promise.all([
      harness.cleanupRequester(ceilingTag),
      harness.cleanupRequester(backlogTag),
      harness.cleanupRequester(interactiveTag),
    ]);
    harness.startWorker("stable-b");
    harness.startWorker("recoverable-a");
    harness.startWorker("recoverable-b");
    await harness.waitForPreferredCoverage().catch(() => undefined);
  }
}
