import type { JobExecutionContext } from "../../index.ts";
import { ScoreAggregator } from "./score-aggregator.ts";

const DEFAULT_DIFFICULTIES = [0, 1, 2, 3, 4, 10] as const;

function getDifficulties(ctx: JobExecutionContext): readonly number[] {
  const diffs = ctx.job.diffsToScrape;
  if (!Array.isArray(diffs) || diffs.length === 0) {
    return DEFAULT_DIFFICULTIES;
  }
  return [...new Set(diffs.filter((d) => Number.isInteger(d)))].sort(
    (a, b) => a - b,
  );
}

export async function updateScore(ctx: JobExecutionContext): Promise<void> {
  console.log(`[JobHandler] Job ${ctx.job.id}: Updating scores...`);
  const updateScoreStartTime = Date.now();

  const difficulties = getDifficulties(ctx);
  const totalDiffs = difficulties.length;
  let completedCount = 0;

  await ctx.applyPatch({
    scoreProgress: { completedDiffs: [], totalDiffs },
    updatedAt: new Date(),
  });

  console.log(
    `[JobHandler] Job ${ctx.job.id}: Fetching scores for diffs [${difficulties.join(",")}]...`,
  );
  const scoreAggregator = new ScoreAggregator(ctx.client);
  const aggregated = await scoreAggregator.fetchAndAggregate(
    ctx.job.friendCode,
    {
      jobId: ctx.job.id,
      difficulties,
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
