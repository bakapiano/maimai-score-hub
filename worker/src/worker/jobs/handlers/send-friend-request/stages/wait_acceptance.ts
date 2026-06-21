import type { JobExecutionContext } from "../../index.ts";
import { TIMEOUTS } from "../../../../../common/maimai/constants.ts";

function parseDateAsCST(dateStr: string): Date {
  if (dateStr.includes("T") || dateStr.includes("Z")) {
    return new Date(dateStr);
  }
  return new Date(`${dateStr.replace(/\//g, "-")}:00+08:00`);
}

async function completeIfFriend(ctx: JobExecutionContext): Promise<boolean> {
  const isFriend = await ctx.client.friends.isFriendBySearchPage(
    ctx.job.friendCode,
  );
  if (!isFriend) {
    return false;
  }

  console.log(`[JobHandler] Job ${ctx.job.id}: Friend accepted!`);
  await ctx.completeJob();
  return true;
}

function getWaitAcceptanceStartedAt(ctx: JobExecutionContext): Date {
  return ctx.job.friendRequestSentAt
    ? parseDateAsCST(ctx.job.friendRequestSentAt)
    : ctx.job.createdAt;
}

function cancelRequestAfterAcceptanceTimeout(ctx: JobExecutionContext): void {
  void ctx.client.friends
    .cancelFriendRequest(ctx.job.friendCode)
    .then(() => {
      console.log(
        `[JobHandler] Job ${ctx.job.id}: Cancelled friend request due to timeout`,
      );
    })
    .catch((cancelErr) => {
      console.warn(
        `[JobHandler] Job ${ctx.job.id}: Failed to cancel friend request:`,
        cancelErr,
      );
    });
}

async function findSentRequestWithRetries(
  ctx: JobExecutionContext,
  maxAttempts: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sent = await ctx.client.friends.hasSentFriendRequest(
      ctx.job.friendCode,
    );

    if (sent) {
      return true;
    }
  }

  return false;
}

export async function waitAcceptance(ctx: JobExecutionContext): Promise<void> {
  console.log(`[JobHandler] Job ${ctx.job.id}: Waiting for acceptance...`);

  if (await ctx.client.friends.hasReceivedFriendRequest(ctx.job.friendCode)) {
    await ctx.client.friends.allowFriendRequest(ctx.job.friendCode);
  }

  if (await completeIfFriend(ctx)) {
    return;
  }

  const waitStartedAt = getWaitAcceptanceStartedAt(ctx);
  const elapsed = Date.now() - waitStartedAt.getTime();
  if (elapsed > TIMEOUTS.friendAcceptWait) {
    cancelRequestAfterAcceptanceTimeout(ctx);
    throw new Error("等待好友接受请求超时");
  }

  const sentRequestStillExists = await findSentRequestWithRetries(ctx, 3);

  if (!sentRequestStillExists) {
    if (await completeIfFriend(ctx)) {
      return;
    }
    throw new Error("好友请求已被取消或删除");
  }

  await ctx.delay(30_000);
  console.log(
    `[JobHandler] Job ${ctx.job.id}: Friend not yet accepted, delaying runAt by 30s`,
  );
}
