import type { JobExecutionContext } from "../../index.ts";

export async function getUserRecentEvent(
  ctx: JobExecutionContext,
): Promise<void> {
  console.log(
    `[JobHandler] Job ${ctx.job.id}: fetching recent events for ${ctx.job.friendCode}`,
  );
  const events = await ctx.client.friends.getFriendRecentEvents(
    ctx.job.friendCode,
  );
  await ctx.applyPatch({
    result: { events },
    status: "completed",
    error: null,
    updatedAt: new Date(),
  });
}
