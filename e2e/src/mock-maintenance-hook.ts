import assert from "node:assert/strict";

import type { MaintenanceRun, SdgbE2eHarness } from "./harness.ts";
import { sleep } from "./polling.ts";

export interface MaintenanceHookInput {
  requestId: string;
  targetWorkerId: string;
}

export class MockMaintenanceHook {
  readonly kind = "noop";
  readonly calls: MaintenanceHookInput[] = [];
  private readonly delayMs: number;

  constructor(delayMs = 300) {
    this.delayMs = delayMs;
  }

  async executeAndObserve(
    harness: SdgbE2eHarness,
    input: MaintenanceHookInput,
  ): Promise<void> {
    const run = await harness.api<MaintenanceRun>(
      `/internal/sdgb/maintenance-runs/active/${input.targetWorkerId}`,
    );
    assert.equal(run.requestId, input.requestId);
    assert.equal(run.targetWorkerId, input.targetWorkerId);
    assert.equal(run.hookMayRun, true);
    assert.equal(run.state, "coverage_ready");
    this.calls.push(input);
    await sleep(this.delayMs);
    const observation = {
      hookAccepted: true,
      connectivityRestored: true,
      completedAt: new Date().toISOString(),
    };
    await harness.api(
      `/internal/sdgb/maintenance-runs/${input.requestId}/hook-observation`,
      {
        method: "POST",
        body: JSON.stringify(observation),
      },
    );
    // Observation delivery is at-least-once. Replaying the exact body must
    // return the existing run and must not execute the hook again.
    await harness.api(
      `/internal/sdgb/maintenance-runs/${input.requestId}/hook-observation`,
      {
        method: "POST",
        body: JSON.stringify(observation),
      },
    );
  }
}
