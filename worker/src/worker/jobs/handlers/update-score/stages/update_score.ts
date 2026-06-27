import type { JobExecutionContext } from "../../index.ts";
import { DIFFICULTIES } from "../../../../../common/maimai/constants.ts";
import { ScoreAggregator } from "./score-aggregator.ts";

export async function updateScore(ctx: JobExecutionContext): Promise<void> {
  console.log(`[JobHandler] Job ${ctx.job.id}: Updating scores...`);
  const updateScoreStartTime = Date.now();

  const totalDiffs = DIFFICULTIES.length;
  let completedCount = 0;

  await ctx.applyPatch({
    scoreProgress: { completedDiffs: [], totalDiffs },
    updatedAt: new Date(),
  });

  console.log(`[JobHandler] Job ${ctx.job.id}: Fetching scores for all diffs...`);
  const scoreAggregator = new ScoreAggregator(ctx.client);
  const aggregated = await scoreAggregator.fetchAndAggregate(
    ctx.job.friendCode,
    {
      jobId: ctx.job.id,
      onDiffCompleted: async (diff: number) => {
        completedCount++;
        console.log(
          `[JobHandler] Job ${ctx.job.id}: Diff ${diff} completed (${completedCount}/${totalDiffs})`,
        );
        await ctx.applyPatch({
          addCompletedDiff: diff,
          updatedAt: new Date(),
        });
      },
    },
  );

  const updateScoreDuration = Date.now() - updateScoreStartTime;
  await ctx.applyPatch({
    result: aggregated,
    status: "completed",
    error: null,
    updateScoreDuration,
    updatedAt: new Date(),
  });

  const cost = ctx.job.updatedAt.getTime() - ctx.job.createdAt.getTime();
  console.log(`[JobHandler] Job ${ctx.job.id}: Completed! Cost: ${cost}ms`);
}
