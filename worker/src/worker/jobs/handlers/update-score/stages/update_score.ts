import { DXNET_DEFAULT_DIFFICULTIES } from "@maimai-score-hub/shared";
import type { JobExecutionContext } from "../../index.ts";
import { ScoreAggregator } from "./score-aggregator.ts";

export function resolveUpdateDifficulties(
  diffs: number[] | null | undefined,
): readonly number[] {
  if (!Array.isArray(diffs) || diffs.length === 0) {
    return DXNET_DEFAULT_DIFFICULTIES;
  }
  return [...new Set(diffs.filter((d) => Number.isInteger(d)))].sort(
    (a, b) => a - b,
  );
}

export async function updateScore(ctx: JobExecutionContext): Promise<void> {
  console.log(`[JobHandler] Job ${ctx.job.id}: Updating scores...`);
  const updateScoreStartTime = Date.now();

  const targets = ctx.job.scoreFetchTargets ?? [];
  const difficulties = targets.length
    ? [...new Set(targets.map((target) => target.diff))].sort((a, b) => a - b)
    : resolveUpdateDifficulties(ctx.job.diffsToScrape);
  const totalDiffs = difficulties.length;
  let completedCount = 0;

  await ctx.applyPatch({
    scoreProgress: { completedDiffs: [], totalDiffs },
    updatedAt: new Date(),
  });

  console.log(
    `[JobHandler] Job ${ctx.job.id}: Fetching scores for diffs [${difficulties.join(",")}] targets=${targets.length} fcfsOnly=${ctx.job.fcfsOnly === true}...`,
  );
  const scoreAggregator = new ScoreAggregator(ctx.client);
  const aggregated = await scoreAggregator.fetchAndAggregate(
    ctx.job.friendCode,
    {
      jobId: ctx.job.id,
      difficulties,
      targets,
      fcfsOnly: ctx.job.fcfsOnly === true,
      ...(targets.length
        ? {}
        : {
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
          }),
    },
  );

  if (targets.length) {
    for (const diff of difficulties) {
      await ctx.applyPatch({ addCompletedDiff: diff, updatedAt: new Date() });
    }
  }

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
