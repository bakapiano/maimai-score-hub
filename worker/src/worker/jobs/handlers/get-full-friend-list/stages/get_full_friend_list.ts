import type { FriendInfo } from "../../../../../common/types.ts";
import type { JobExecutionContext } from "../../index.ts";
import { postBotStatus } from "../../../../../common/backend/bots.ts";

type BotStatusFriend = Omit<FriendInfo, "isFavorite">;

export async function getFullFriendList(
  ctx: JobExecutionContext,
): Promise<void> {
  const botFriendCode = ctx.job.botUserFriendCode;
  if (!botFriendCode) {
    throw new Error("get_full_friend_list requires botUserFriendCode");
  }

  const friends = await ctx.client.friends.getFriendList();
  const friendsUpdatedAt = new Date();

  await postBotStatus({
    friendCode: botFriendCode,
    available: true,
    friendCount: friends.length,
    friendsUpdatedAt: friendsUpdatedAt.toISOString(),
    friends: friends.map(toBotStatusFriend),
  });

  await ctx.applyPatch({
    result: {
      friendCount: friends.length,
      friendsUpdatedAt: friendsUpdatedAt.toISOString(),
    },
    updatedAt: new Date(),
  });
  await ctx.completeJob();
}

function toBotStatusFriend({
  isFavorite: _isFavorite,
  ...friend
}: FriendInfo): BotStatusFriend {
  return friend;
}
