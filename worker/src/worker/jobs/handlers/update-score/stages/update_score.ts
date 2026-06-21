import type { AggregatedScoreResult } from "../../../../../common/types.ts";
import type { JobExecutionContext } from "../../index.ts";
import { DIFFICULTIES } from "../../../../../common/maimai/constants.ts";
import { ScoreAggregator } from "./score-aggregator.ts";

export async function updateScore(ctx: JobExecutionContext): Promise<void> {
  if (ctx.job.skipUpdateScore) {
    console.log(
      `[JobHandler] Job ${ctx.job.id}: Skipping update_score (skipUpdateScore=true).`,
    );
    await ctx.completeJob();
    return;
  }

  console.log(`[JobHandler] Job ${ctx.job.id}: Updating scores...`);
  const updateScoreStartTime = Date.now();

  let effectiveDiffs: number[] = [...DIFFICULTIES];
  if (Array.isArray(ctx.job.diffsToScrape) && ctx.job.diffsToScrape.length > 0) {
    const requested = new Set(ctx.job.diffsToScrape);
    effectiveDiffs = effectiveDiffs.filter((d) => requested.has(d));
    console.log(
      `[JobHandler] Job ${ctx.job.id}: backend pinned diffsToScrape=[${ctx.job.diffsToScrape.join(",")}], scraping [${effectiveDiffs.join(",")}]`,
    );
  }

  const skipDxScoreFetch =
    !!ctx.job.cabinetScoreMap &&
    Object.keys(ctx.job.cabinetScoreMap).length > 0;
  if (skipDxScoreFetch) {
    console.log(
      `[JobHandler] Job ${ctx.job.id}: skipDxScoreFetch=true (cabinet data has ${Object.keys(ctx.job.cabinetScoreMap!).length} entries)`,
    );
  }

  const totalDiffs = effectiveDiffs.length;
  let completedCount = 0;

  if (totalDiffs === 0) {
    console.log(
      `[JobHandler] Job ${ctx.job.id}: nothing to scrape (effectiveDiffs empty); cabinet-only update.`,
    );
    const updateScoreDuration = Date.now() - updateScoreStartTime;
    await ctx.applyPatch({
      result: {} as AggregatedScoreResult,
      status: "completed",
      error: null,
      updateScoreDuration,
      updatedAt: new Date(),
    });
    return;
  }

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
      diffs: effectiveDiffs,
      skipDxScoreFetch,
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
