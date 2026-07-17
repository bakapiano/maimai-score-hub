import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { makeJob } from "../job-fixtures.ts";
import {
  type MaintenanceRun,
  type SdgbE2eHarness,
} from "../harness.ts";
import { MockMaintenanceHook } from "../mock-maintenance-hook.ts";
import { waitFor } from "../polling.ts";

export async function verifyEmptyRecovery(
  harness: SdgbE2eHarness,
): Promise<void> {
  const requesterTag = `empty-recovery-${randomUUID()}`;
  const targetWorkerId = harness.workerIds["recoverable-a"];
  const startedAt = new Date();
  let requestId: string | undefined;

  await harness.waitForPreferredCoverage();
  const records = Array.from({ length: 12 }, (_, index) =>
    makeJob({
      id: `${requesterTag}-${index}`,
      jobType: "get_user_map",
      requesterTag,
      payload: { cabinetUserId: 99_999_999 },
    }),
  );

  try {
    await harness.insertAndEnqueue(records);
    await waitFor(
      "empty-response maintenance creation",
      async () => {
        const run = await harness.maintenanceRuns.findOne({
          targetWorkerId,
          reason: "network_recovery",
          createdAt: { $gte: startedAt },
        });
        requestId = run?.requestId;
        return { done: Boolean(requestId), requestId, state: run?.state };
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );
    await harness.waitForActiveMembers("probe", [
      harness.workerIds["recoverable-b"],
    ]);
    const coverage = await waitFor(
      "empty-response maintenance coverage",
      async () => {
        const run = await harness.maintenanceRuns.findOne({
          targetWorkerId,
          reason: "network_recovery",
          createdAt: { $gte: startedAt },
        });
        requestId = run?.requestId;
        return {
          done: run?.state === "coverage_ready",
          requestId: run?.requestId,
          state: run?.state,
        };
      },
      { timeoutMs: 45_000, intervalMs: 100 },
    );
    assert.ok(coverage.requestId);
    await harness.assertNoMembership("probe", [
      harness.workerIds["stable-a"],
      harness.workerIds["stable-b"],
    ]);
    const blocked = await harness.workerHeartbeat(targetWorkerId);
    assert.equal(blocked?.breakerState, "open");
    assert.equal(blocked?.upstreamHealth, "blocked");
    const blockedNetworkEpoch = blocked?.networkEpoch ?? 0;

    const completed = await harness.waitForJobs(
      requesterTag,
      records.length,
      "completed",
      45_000,
    );
    assert.ok(
      completed.every((job) =>
        String(job.lastWorkerId).endsWith("-recoverable-b"),
      ),
      "retried probe jobs should run on the remaining Recoverable member",
    );

    const interactiveTag = `hook-interactive-${randomUUID()}`;
    const interactiveJobs = Array.from({ length: 4 }, (_, index) =>
      makeJob({
        id: `${interactiveTag}-${index}`,
        jobType: "scan_qr",
        requesterTag: interactiveTag,
      }),
    );
    const hook = new MockMaintenanceHook(500);
    await harness.insertAndEnqueue(interactiveJobs);
    await Promise.all([
      hook.executeAndObserve(harness, {
        requestId: requestId!,
        targetWorkerId,
      }),
      harness.waitForJobs(interactiveTag, interactiveJobs.length),
    ]);
    assert.deepEqual(hook.calls, [{ requestId, targetWorkerId }]);
    const interactiveCompleted = await harness.jobs
      .find({ requesterTag: interactiveTag })
      .toArray();
    assert.ok(
      interactiveCompleted.every((job) =>
        String(job.lastWorkerId).includes("-stable-"),
      ),
    );
    await harness.cleanupRequester(interactiveTag);

    await waitFor(
      "maintenance health verification and preferred handback",
      async () => {
        const [run, members] = await Promise.all([
          harness.api<MaintenanceRun>(
            `/internal/sdgb/maintenance-runs/${requestId}`,
          ),
          harness.desiredMembers("probe"),
        ]);
        const active = members
          .filter((member) => member.state === "active")
          .map((member) => member.workerId);
        return {
          done:
            run.state === "completed" &&
            active.length === 2 &&
            active.includes(targetWorkerId) &&
            active.includes(harness.workerIds["recoverable-b"]),
          state: run.state,
          active,
        };
      },
      { timeoutMs: 45_000, intervalMs: 100 },
    );
    const recovered = await harness.workerHeartbeat(targetWorkerId);
    assert.ok(recovered!.networkEpoch > blockedNetworkEpoch);
  } finally {
    await harness.cleanupRequester(requesterTag);
    if (requestId) {
      await harness.maintenanceRuns.deleteOne({ requestId });
    }
    harness.startWorker("recoverable-b");
    await harness.waitForPreferredCoverage().catch(() => undefined);
  }
}
