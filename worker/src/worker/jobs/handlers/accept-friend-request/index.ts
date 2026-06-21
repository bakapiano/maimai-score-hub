import type { JobExecutionContext, JobTypeHandler } from "../index.ts";

import { acceptRequest } from "./stages/accept_request.ts";
import { prepareTargetProfile } from "../common.ts";
import { waitForUserRequest } from "./stages/wait_user_request.ts";

export const acceptFriendRequestJobHandler: JobTypeHandler = {
  prepare: prepareTargetProfile,
  execute: handleAcceptFriendRequestJob,
};

export async function handleAcceptFriendRequestJob(
  ctx: JobExecutionContext,
): Promise<void> {
  switch (ctx.job.stage) {
    case "wait_user_request":
      await waitForUserRequest(ctx);
      return;
    case "accept_request":
      await acceptRequest(ctx);
      return;
    default:
      throw new Error(
        `accept_friend_request does not support stage ${ctx.job.stage}`,
      );
  }
}
