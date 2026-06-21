import type { JobExecutionContext } from "./index.ts";

export async function prepareTargetProfile(
  ctx: JobExecutionContext,
): Promise<void> {
  if (ctx.job.profile) {
    return;
  }

  const profile = await ctx.client.profiles.getUserProfile(ctx.job.friendCode);
  if (!profile) {
    throw new Error("未找到该好友代码对应的用户，请检查好友代码是否正确!");
  }

  await ctx.applyPatch({ profile, updatedAt: new Date() });
}
