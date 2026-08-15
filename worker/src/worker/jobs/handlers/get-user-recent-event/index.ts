import type {
  JobExecutionContext,
  JobPreflightResult,
  JobTypeHandler,
} from "../index.ts";
import { requiredFriendCode } from "../common.ts";
import { getUserRecentEvent } from "./stages/get_user_recent_event.ts";

export const getUserRecentEventJobHandler: JobTypeHandler = {
  preflight: preflightClaimRecentEvent,
  execute: handleGetUserRecentEventJob,
};

async function preflightClaimRecentEvent(
  ctx: JobExecutionContext,
): Promise<JobPreflightResult> {
  const routing = ctx.job.routing;
  if (routing?.assignmentMode !== "claim") {
    return "continue";
  }

  if (routing.deliveryMode === "shared") {
    await ctx.applyPatch({
      status: "queued",
      handoff: {
        deliveryMode: "pinned",
        runAt: new Date(Date.now() + 3 * 60_000).toISOString(),
      },
      updatedAt: new Date(),
    });
    return "complete_delivery";
  }

  if (
    routing.deliveryMode === "pinned" &&
    !(await ctx.client.friends.isFriend(requiredFriendCode(ctx)))
  ) {
    await ctx.fail("Background cabinet friendship could not be confirmed", {
      errorCode: "cabinet_friendship_unconfirmed",
      updatedAt: new Date(),
    });
    return "complete_delivery";
  }

  return "continue";
}

export async function handleGetUserRecentEventJob(
  ctx: JobExecutionContext,
): Promise<void> {
  if (ctx.job.stage !== "get_user_recent_event") {
    throw new Error(
      `get_user_recent_event does not support stage ${ctx.job.stage}`,
    );
  }

  await getUserRecentEvent(ctx);
}
