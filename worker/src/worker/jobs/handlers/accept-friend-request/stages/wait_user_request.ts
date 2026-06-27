import type { AcceptFriendRequest } from "../../../../../common/types.ts";
import type { JobExecutionContext } from "../../index.ts";
import { acceptRequest } from "./accept_request.ts";

function getFriendRequestWaitStartedAt(ctx: JobExecutionContext): Date {
  const source = ctx.job.friendRequestWaitStartedAt
    ? new Date(ctx.job.friendRequestWaitStartedAt)
    : ctx.job.createdAt;
  return new Date(Math.floor(source.getTime() / 60_000) * 60_000);
}

function getRequestAppliedAtMs(request: AcceptFriendRequest): number | null {
  if (!request.appliedAt) {
    return null;
  }

  const time = new Date(request.appliedAt).getTime();
  return Number.isFinite(time) ? time : null;
}

function findValidUserRequest(
  requests: AcceptFriendRequest[],
  friendCode: string,
  waitStartedAt: Date,
): AcceptFriendRequest | undefined {
  const waitStartedAtMs = waitStartedAt.getTime();
  return requests.find((request) => {
    if (request.friendCode !== friendCode) {
      return false;
    }

    const appliedAtMs = getRequestAppliedAtMs(request);
    return appliedAtMs !== null && appliedAtMs >= waitStartedAtMs;
  });
}

async function blockStaleUserRequests(
  ctx: JobExecutionContext,
  requests: AcceptFriendRequest[],
  waitStartedAt: Date,
): Promise<number> {
  const waitStartedAtMs = waitStartedAt.getTime();
  const staleRequests = requests.filter((request) => {
    if (request.friendCode !== ctx.job.friendCode) {
      return false;
    }

    const appliedAtMs = getRequestAppliedAtMs(request);
    return appliedAtMs !== null && appliedAtMs < waitStartedAtMs;
  });

  for (const request of staleRequests) {
    try {
      console.log(
        `[JobHandler] Job ${ctx.job.id}: Blocking stale user friend request appliedAt=${request.appliedAt}`,
      );
      await ctx.client.friends.blockFriendRequest(request.friendCode);
    } catch (err) {
      console.warn(
        `[JobHandler] Job ${ctx.job.id}: Failed to block stale user friend request:`,
        err,
      );
    }
  }

  return staleRequests.length;
}

export async function waitForUserRequest(
  ctx: JobExecutionContext,
): Promise<void> {
  console.log(
    `[JobHandler] Job ${ctx.job.id}: Verifying user friend request...`,
  );

  const waitStartedAt = getFriendRequestWaitStartedAt(ctx);
  if (Date.now() - waitStartedAt.getTime() > 5 * 60_000) {
    throw new Error("等待用户发送好友申请超时");
  }

  const pending = await ctx.client.friends.getAcceptRequests();
  const match = findValidUserRequest(
    pending,
    ctx.job.friendCode,
    waitStartedAt,
  );

  if (!match) {
    const staleRequestCount = await blockStaleUserRequests(
      ctx,
      pending,
      waitStartedAt,
    );
    if (
      staleRequestCount === 0 &&
      (await ctx.client.friends.hasReceivedFriendRequest(ctx.job.friendCode))
    ) {
      await ctx.transitionTo("accept_request");
      await acceptRequest(ctx);
      return;
    }

    await ctx.delay(30_000, {
      stage: "wait_user_request",
    });
    console.log(
      `[JobHandler] Job ${ctx.job.id}: No valid user request found, delaying runAt by 30s`,
    );
    return;
  }

  await ctx.transitionTo("accept_request");
  await acceptRequest(ctx);
}
