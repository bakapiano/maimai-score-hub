import type { JobExecutionContext, JobTypeHandler } from "../index.ts";

import { prepareTargetProfile } from "../common.ts";
import { sendRequest } from "./stages/send_request.ts";
import { waitAcceptance } from "./stages/wait_acceptance.ts";

export const sendFriendRequestJobHandler: JobTypeHandler = {
  prepare: prepareTargetProfile,
  execute: handleSendFriendRequestJob,
};

export async function handleSendFriendRequestJob(
  ctx: JobExecutionContext,
): Promise<void> {
  switch (ctx.job.stage) {
    case "send_request":
      await sendRequest(ctx);
      return;
    case "wait_acceptance":
      await waitAcceptance(ctx);
      return;
    default:
      throw new Error(
        `send_friend_request does not support stage ${ctx.job.stage}`,
      );
  }
}
