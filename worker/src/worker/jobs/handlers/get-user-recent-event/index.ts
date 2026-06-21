import type { JobExecutionContext, JobTypeHandler } from "../index.ts";
import { getUserRecentEvent } from "./stages/get_user_recent_event.ts";

export const getUserRecentEventJobHandler: JobTypeHandler = {
  execute: handleGetUserRecentEventJob,
};

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
