import type { JobExecutionContext } from "../../index.ts";

export async function acceptRequest(ctx: JobExecutionContext): Promise<void> {
  console.log(
    `[JobHandler] Job ${ctx.job.id}: Accepting user friend request...`,
  );
  await ctx.client.friends.allowFriendRequest(ctx.job.friendCode);
  await ctx.completeJob();
}
