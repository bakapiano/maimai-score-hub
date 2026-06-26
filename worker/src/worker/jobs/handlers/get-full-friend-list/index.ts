import type { JobExecutionContext, JobTypeHandler } from "../index.ts";
import { getFullFriendList } from "./stages/get_full_friend_list.ts";

export const getFullFriendListJobHandler: JobTypeHandler = {
  execute: handleGetFullFriendListJob,
};

export async function handleGetFullFriendListJob(
  ctx: JobExecutionContext,
): Promise<void> {
  if (ctx.job.stage !== "get_full_friend_list") {
    throw new Error(
      `get_full_friend_list does not support stage ${ctx.job.stage}`,
    );
  }

  await getFullFriendList(ctx);
}
