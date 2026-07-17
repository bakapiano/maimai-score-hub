import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { makeJob } from "../job-fixtures.ts";
import type { SdgbE2eHarness } from "../harness.ts";

export async function verifyGracefulUpgrade(
  harness: SdgbE2eHarness,
): Promise<void> {
  const requesterTag = `graceful-upgrade-${randomUUID()}`;
  const stableA = harness.workerIds["stable-a"];
  const stableB = harness.workerIds["stable-b"];
  try {
    await harness.killWorker("stable-b");
    await harness.waitForActiveMembers("interactive", [stableA]);
    const owner = await harness.prepareMusicScoreFixture();
    const scan = makeJob({
      id: `${requesterTag}-scan`,
      jobType: "scan_qr",
      requesterTag,
      payload: { qrCode: "e2e-slow-scan" },
    });
    const add = makeJob({
      id: `${requesterTag}-add`,
      jobType: "add_rival",
      requesterTag,
      payload: {
        botCabinetUserId: 10_000_001,
        targetCabinetUserId: 88_888_888,
      },
    });
    const music = makeJob({
      id: `${requesterTag}-music`,
      jobType: "get_music_score",
      requesterTag,
      payload: {
        qrCode: "e2e-slow-music",
        expectedCabinetUserId: owner.cabinetUserId,
      },
    });
    music.ownerUserId = owner.ownerUserId;
    music.ownerFriendCode = owner.ownerFriendCode;

    await harness.insertAndEnqueue([scan, add, music]);
    const processing = await harness.waitForProcessingJobs(requesterTag, 3);
    assert.ok(processing.every((job) => job.executionWorkerId === stableA));

    harness.startWorker("stable-b");
    await harness.waitForActiveMembers("interactive", [stableA, stableB]);
    await harness.stopWorker("stable-a");

    const completed = await harness.waitForJobs(
      requesterTag,
      3,
      "completed",
      15_000,
    );
    assert.ok(completed.every((job) => job.error === null));
    const musicCompleted = completed.find(
      (job) => job.jobType === "get_music_score",
    );
    assert.equal(musicCompleted?.cleanupStatus, "succeeded");
    await harness.waitForActiveMembers("interactive", [stableB]);
  } finally {
    await harness.cleanupRequester(requesterTag);
    harness.startWorker("stable-a");
    harness.startWorker("stable-b");
    await harness.waitForPreferredCoverage().catch(() => undefined);
  }
}
