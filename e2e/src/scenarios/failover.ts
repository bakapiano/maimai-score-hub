import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  makeJob,
  type SdgbJobType,
  type SdgbLane,
} from "../job-fixtures.ts";
import type { SdgbE2eHarness } from "../harness.ts";

export async function verifyFailoverAndHandback(
  harness: SdgbE2eHarness,
): Promise<void> {
  try {
    await verifyProbeFailover(harness);
    await verifyInteractiveFailover(harness);
  } finally {
    for (const slot of [
      "stable-a",
      "stable-b",
      "recoverable-a",
      "recoverable-b",
    ] as const) {
      harness.startWorker(slot);
    }
    await harness.waitForPreferredCoverage().catch(() => undefined);
  }
}

async function verifyProbeFailover(harness: SdgbE2eHarness): Promise<void> {
  await harness.killWorker("recoverable-a");
  await harness.waitForActiveMembers("probe", [
    harness.workerIds["recoverable-b"],
  ]);
  await harness.assertNoMembership("probe", [
    harness.workerIds["stable-a"],
    harness.workerIds["stable-b"],
  ]);
  await runBatch(harness, "probe", "get_user_map", 6, [
    harness.workerIds["recoverable-b"],
  ]);

  await harness.killWorker("recoverable-b");
  await harness.waitForActiveMembers("probe", [
    harness.workerIds["stable-a"],
    harness.workerIds["stable-b"],
  ]);
  await runBatch(harness, "probe", "get_user_map", 10, [
    harness.workerIds["stable-a"],
    harness.workerIds["stable-b"],
  ]);

  const drainingTag = `probe-handback-${randomUUID()}`;
  const drainingJob = makeJob({
    id: `${drainingTag}-slow`,
    jobType: "get_user_map",
    requesterTag: drainingTag,
    payload: { cabinetUserId: 88_888_888 },
  });
  await harness.insertAndEnqueue([drainingJob]);
  const [processing] = await harness.waitForProcessingJobs(drainingTag, 1);
  assert.ok(String(processing?.executionWorkerId).includes("-stable-"));
  harness.startWorker("recoverable-a");
  harness.startWorker("recoverable-b");
  await harness.waitForActiveMembers("probe", [
    harness.workerIds["recoverable-a"],
    harness.workerIds["recoverable-b"],
  ]);
  await harness.assertNoMembership("probe", [
    harness.workerIds["stable-a"],
    harness.workerIds["stable-b"],
  ]);
  const [drained] = await harness.waitForJobs(drainingTag, 1);
  assert.ok(String(drained?.lastWorkerId).includes("-stable-"));
  await harness.cleanupRequester(drainingTag);
  await runBatch(harness, "probe", "get_user_map", 10, [
    harness.workerIds["recoverable-a"],
    harness.workerIds["recoverable-b"],
  ]);
}

async function verifyInteractiveFailover(
  harness: SdgbE2eHarness,
): Promise<void> {
  await harness.killWorker("stable-a");
  await harness.waitForActiveMembers("interactive", [
    harness.workerIds["stable-b"],
  ]);
  await harness.assertNoMembership("interactive", [
    harness.workerIds["recoverable-a"],
    harness.workerIds["recoverable-b"],
  ]);
  await runBatch(harness, "interactive", "scan_qr", 6, [
    harness.workerIds["stable-b"],
  ]);

  await harness.killWorker("stable-b");
  await harness.waitForActiveMembers("interactive", [
    harness.workerIds["recoverable-a"],
    harness.workerIds["recoverable-b"],
  ]);
  await runBatch(harness, "interactive", "scan_qr", 10, [
    harness.workerIds["recoverable-a"],
    harness.workerIds["recoverable-b"],
  ]);

  const drainingTag = `interactive-handback-${randomUUID()}`;
  const drainingJob = makeJob({
    id: `${drainingTag}-slow`,
    jobType: "scan_qr",
    requesterTag: drainingTag,
    payload: { qrCode: "e2e-slow-handback" },
  });
  await harness.insertAndEnqueue([drainingJob]);
  const [processing] = await harness.waitForProcessingJobs(drainingTag, 1);
  assert.ok(String(processing?.executionWorkerId).includes("-recoverable-"));
  harness.startWorker("stable-a");
  harness.startWorker("stable-b");
  await harness.waitForActiveMembers("interactive", [
    harness.workerIds["stable-a"],
    harness.workerIds["stable-b"],
  ]);
  await harness.assertNoMembership("interactive", [
    harness.workerIds["recoverable-a"],
    harness.workerIds["recoverable-b"],
  ]);
  const [drained] = await harness.waitForJobs(drainingTag, 1);
  assert.ok(String(drained?.lastWorkerId).includes("-recoverable-"));
  await harness.cleanupRequester(drainingTag);
  await runBatch(harness, "interactive", "scan_qr", 10, [
    harness.workerIds["stable-a"],
    harness.workerIds["stable-b"],
  ]);
}

async function runBatch(
  harness: SdgbE2eHarness,
  lane: SdgbLane,
  jobType: SdgbJobType,
  count: number,
  expectedWorkers: readonly string[],
): Promise<void> {
  const requesterTag = `failover-${lane}-${randomUUID()}`;
  const records = Array.from({ length: count }, (_, index) =>
    makeJob({
      id: `${requesterTag}-${index}`,
      jobType,
      requesterTag,
    }),
  );
  try {
    await harness.insertAndEnqueue(records);
    const completed = await harness.waitForJobs(requesterTag, count);
    const actual = new Set(completed.map((job) => job.lastWorkerId));
    assert.deepEqual(
      [...actual].sort(),
      [...expectedWorkers].sort(),
      `${lane} should be handled by the expected active member set`,
    );
  } finally {
    await harness.cleanupRequester(requesterTag);
  }
}
