import type {
  JobExecutionContext,
  JobPreflightResult,
  JobTypeHandler,
} from "../index.ts";

import { prepareTargetProfile, requiredFriendCode } from "../common.ts";
import { updateScore } from "./stages/update_score.ts";

export const updateScoreJobHandler: JobTypeHandler = {
  preflight: preflightClaimFriendship,
  prepare: prepareTargetProfile,
  execute: handleUpdateScoreJob,
};

async function preflightClaimFriendship(
  ctx: JobExecutionContext,
): Promise<JobPreflightResult> {
  const preparedCabinetFriendship = ["ready", "uncertain"].includes(
    ctx.job.cabinetFriendshipStatus ?? "",
  );
  if (
    ctx.job.routing?.assignmentMode !== "claim" &&
    !preparedCabinetFriendship
  ) {
    return "continue";
  }

  const friendCode = requiredFriendCode(ctx);
  for (const delayMs of [0, 2_000, 5_000]) {
    if (delayMs > 0) await ctx.sleep(delayMs);
    if (await ctx.client.friends.isFriend(friendCode)) {
      return "continue";
    }
  }

  await ctx.fail("Cabinet friendship could not be confirmed on DXNet", {
    errorCode: "cabinet_friendship_unconfirmed",
    updatedAt: new Date(),
  });
  return "complete_delivery";
}

export async function handleUpdateScoreJob(
  ctx: JobExecutionContext,
): Promise<void> {
  switch (ctx.job.stage) {
    case "update_score":
      await updateScore(ctx);
      return;
    default:
      throw new Error(`update_score does not support stage ${ctx.job.stage}`);
  }
}
