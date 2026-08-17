import type { JobExecutionContext } from "./index.ts";

export function requiredFriendCode(ctx: JobExecutionContext): string {
  if (!ctx.job.friendCode) {
    throw new Error(`DXNet job ${ctx.job.id} has no friendCode`);
  }
  return ctx.job.friendCode;
}

export async function prepareTargetProfile(
  ctx: JobExecutionContext,
): Promise<void> {
  if (ctx.job.profile) {
    return;
  }

  const profile = await ctx.client.profiles.getUserProfile(
    requiredFriendCode(ctx),
  );
  if (!profile) {
    throw new Error("未找到该好友代码对应的用户，请检查好友代码是否正确!");
  }

  await ctx.applyPatch({ profile, updatedAt: new Date() });
}
