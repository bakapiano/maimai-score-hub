import type { JobExecutionContext } from "../../index.ts";
import { runInBatch } from "../../../../../common/maimai/infra/request-runtime.ts";

type RetrySendResult =
  | { kind: "already-friend" }
  | { kind: "sent" }
  | { kind: "not-found" };

async function sendAndVerifyRecentRequest(
  ctx: JobExecutionContext,
): Promise<boolean> {
  try {
    return await runInBatch(async () => {
      await ctx.client.friends.sendFriendRequest(ctx.job.friendCode);
      return ctx.client.friends.hasSentFriendRequest(ctx.job.friendCode);
    }, "send+verify-friend-request");
  } catch (err) {
    console.warn(
      `[JobHandler] Job ${ctx.job.id}: Failed to verify sent friend request:`,
      err,
    );
    return false;
  }
}

async function retrySendAndVerifyRequest(
  ctx: JobExecutionContext,
  maxRetries: number,
): Promise<RetrySendResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await runInBatch(async () => {
      await ctx.client.friends.sendFriendRequest(ctx.job.friendCode);

      const alreadyFriend = await ctx.client.friends.isFriendBySearchPage(
        ctx.job.friendCode,
      );
      if (alreadyFriend) {
        return { kind: "already-friend" as const };
      }

      const sent = await ctx.client.friends.hasSentFriendRequest(
        ctx.job.friendCode,
      );
      return sent ? { kind: "sent" as const } : { kind: "not-found" as const };
    }, "send+verify-friend-request-retry");

    if (result.kind === "already-friend") {
      return result;
    }

    if (result.kind === "sent") {
      return result;
    }

    if (attempt < maxRetries) {
      console.warn(
        `[JobHandler] Job ${ctx.job.id}: Friend request not found in sent list, retrying (${attempt}/${maxRetries})...`,
      );
    }
  }

  return { kind: "not-found" };
}

export async function sendRequest(ctx: JobExecutionContext): Promise<void> {
  console.log(`[JobHandler] Job ${ctx.job.id}: Sending friend request...`);

  let requestSent = await sendAndVerifyRecentRequest(ctx);

  if (!requestSent) {
    await ctx.client.friends.cleanUpFriend(ctx.job.friendCode);

    const retryResult = await retrySendAndVerifyRequest(ctx, 3);
    if (retryResult.kind === "already-friend") {
      console.log(
        `[JobHandler] Job ${ctx.job.id}: Already friends after sending request, treating as success`,
      );
      await ctx.completeJob();
      return;
    }
    requestSent = retryResult.kind === "sent";
  }

  if (!requestSent) {
    throw new Error("发送好友请求失败");
  }

  const waitAcceptanceStartedAt = new Date();

  await ctx.transitionTo("wait_acceptance", {
    friendRequestSentAt: waitAcceptanceStartedAt.toISOString(),
    updatedAt: waitAcceptanceStartedAt,
  });
}
