import type { JobExecutionContext, JobTypeHandler } from "../index.ts";

import { prepareTargetProfile } from "../common.ts";
import { updateScore } from "./stages/update_score.ts";

export const updateScoreJobHandler: JobTypeHandler = {
  prepare: prepareTargetProfile,
  execute: handleUpdateScoreJob,
};

export async function handleUpdateScoreJob(
  ctx: JobExecutionContext,
): Promise<void> {
  switch (ctx.job.stage) {
    case "update_score":
      await updateScore(ctx);
      return;
    default:
      throw new Error(`update_score does not support stage ${ctx.job.stage}`);
  }
}
