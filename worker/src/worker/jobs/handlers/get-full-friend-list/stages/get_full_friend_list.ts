import { botManager } from "../../../../../common/bots/bot-manager.ts";
import type { JobExecutionContext } from "../../index.ts";

export async function getFullFriendList(
  ctx: JobExecutionContext,
): Promise<void> {
  const botFriendCode = ctx.job.botUserFriendCode;
  if (!botFriendCode) {
    throw new Error("get_full_friend_list requires botUserFriendCode");
  }

  const friends = await ctx.client.friends.getFriendList();
  const friendsUpdatedAt = new Date();

  await ctx.applyPatch({
    result: {
      friendCount: friends.length,
      friendsUpdatedAt: friendsUpdatedAt.toISOString(),
    },
    updatedAt: new Date(),
  });
  await ctx.completeJob();
}
