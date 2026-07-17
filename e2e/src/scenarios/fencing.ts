import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { makeJob } from "../job-fixtures.ts";
import type { SdgbE2eHarness } from "../harness.ts";

export async function verifyMembershipFencing(
  harness: SdgbE2eHarness,
): Promise<void> {
  const unauthorizedTag = `unauthorized-fence-${randomUUID()}`;
  const staleTag = `stale-fence-${randomUUID()}`;
  const recoverableA = harness.workerIds["recoverable-a"];
  try {
    const unauthorized = makeJob({
      id: `${unauthorizedTag}-job`,
      jobType: "get_user_map",
      requesterTag: unauthorizedTag,
    });
    await harness.insertOnly([unauthorized]);
    const unauthorizedStatus = await harness.apiStatus(
      `/workers/sdgb/jobs/${unauthorized.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          executionToken: randomUUID(),
          executionWorkerId: "not-a-desired-worker",
          executionMembershipEpoch: 999_999,
          executionNetworkEpoch: 1,
          status: "processing",
        }),
      },
    );
    assert.equal(unauthorizedStatus, 409);

    await harness.killWorker("recoverable-b");
    await harness.waitForActiveMembers("probe", [recoverableA]);
    const stale = makeJob({
      id: `${staleTag}-job`,
      jobType: "get_user_map",
      requesterTag: staleTag,
      payload: { cabinetUserId: 88_888_888 },
    });
    await harness.insertAndEnqueue([stale]);
    const [processing] = await harness.waitForProcessingJobs(staleTag, 1);
    assert.equal(processing?.executionWorkerId, recoverableA);
    assert.ok(processing?.executionToken);
    assert.ok(processing?.executionMembershipEpoch);
    assert.ok(processing?.executionNetworkEpoch);

    await harness.killWorker("recoverable-a");
    await harness.waitForMembershipAbsent("probe", recoverableA);
    const staleStatus = await harness.apiStatus(
      `/workers/sdgb/jobs/${stale.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          executionToken: processing!.executionToken,
          executionWorkerId: processing!.executionWorkerId,
          executionMembershipEpoch: processing!.executionMembershipEpoch,
          executionNetworkEpoch: processing!.executionNetworkEpoch,
          status: "completed",
          result: { maps: [] },
        }),
      },
    );
    assert.equal(staleStatus, 409);
    const unchanged = await harness.jobs.findOne({ id: stale.id });
    assert.equal(unchanged?.status, "processing");
    assert.equal(unchanged?.executionToken, processing?.executionToken);
  } finally {
    await Promise.all([
      harness.cleanupRequester(unauthorizedTag),
      harness.cleanupRequester(staleTag),
    ]);
    harness.startWorker("recoverable-a");
    harness.startWorker("recoverable-b");
    await harness.waitForPreferredCoverage().catch(() => undefined);
  }
}
