import test from "node:test";

import { SdgbE2eHarness } from "./harness.ts";
import { verifyActiveActiveDistribution } from "./scenarios/active-active.ts";
import { verifyEmptyRecovery } from "./scenarios/empty-recovery.ts";
import { verifyMembershipFencing } from "./scenarios/fencing.ts";
import { verifyFailoverAndHandback } from "./scenarios/failover.ts";
import { verifyGracefulUpgrade } from "./scenarios/graceful-upgrade.ts";
import { verifyLaneRouting } from "./scenarios/lane-routing.ts";
import { verifyStableFailoverQos } from "./scenarios/stable-qos.ts";
import { verifyDxnetClaimRouting } from "./scenarios/dxnet-claim-routing.ts";

test(
  "Backend and sdgb-worker integration",
  { timeout: 360_000 },
  async (context) => {
    const harness = await SdgbE2eHarness.start();
    console.log(
      `[e2e] infra=${harness.infrastructure.mode} mongoDb=${harness.infrastructure.mongo.database} redisPrefix=${harness.redisPrefix}`,
    );
    context.after(async () => {
      await harness.stop();
    });

    if (shouldRun("lane-routing"))
      await context.test("routes each job through its declared lane", async () => {
        await withDiagnostics(harness, () => verifyLaneRouting(harness));
      });
    if (shouldRun("active-active"))
      await context.test("distributes both lanes across 2+2 active members", async () => {
        await withDiagnostics(harness, () =>
          verifyActiveActiveDistribution(harness),
        );
      });
    if (shouldRun("failover"))
      await context.test(
      "keeps same-class coverage, fails over, and hands back both lanes",
      { timeout: 90_000 },
      async () => {
        await withDiagnostics(harness, () =>
          verifyFailoverAndHandback(harness),
        );
      },
      );
    if (shouldRun("empty-recovery"))
      await context.test(
      "requeues empty responses behind maintenance coverage and recovers",
      { timeout: 90_000 },
      async () => {
        await withDiagnostics(harness, () => verifyEmptyRecovery(harness));
      },
      );
    if (shouldRun("stable-qos"))
      await context.test(
      "keeps Interactive within its Stable failover QoS budget",
      { timeout: 60_000 },
      async () => {
        await withDiagnostics(harness, () =>
          verifyStableFailoverQos(harness),
        );
      },
      );
    if (shouldRun("graceful-upgrade"))
      await context.test(
      "gracefully drains active Interactive jobs during an upgrade",
      { timeout: 60_000 },
      async () => {
        await withDiagnostics(harness, () => verifyGracefulUpgrade(harness));
      },
      );
    if (shouldRun("fencing"))
      await context.test(
      "rejects unauthorized membership and stale execution writes",
      { timeout: 60_000 },
      async () => {
        await withDiagnostics(harness, () =>
          verifyMembershipFencing(harness),
        );
      },
      );
    if (shouldRun("dxnet-claim-routing"))
      await context.test(
        "routes and fences a DXNet claim through competing BullMQ consumers",
        { timeout: 60_000 },
        async () => {
          await withDiagnostics(harness, () =>
            verifyDxnetClaimRouting(harness),
          );
        },
      );
  },
);

function shouldRun(id: string): boolean {
  return !process.env.E2E_SCENARIO || process.env.E2E_SCENARIO === id;
}

async function withDiagnostics(
  harness: SdgbE2eHarness,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(harness.processDiagnostics());
    throw error;
  }
}
