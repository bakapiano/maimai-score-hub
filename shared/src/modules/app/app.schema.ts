import { z } from "zod";

import { JobRecentStatsSchema } from "../job/job.schema";

export const AppStatisticsSchema = z.object({
  dxnetJobs: JobRecentStatsSchema,
});

export type AppStatistics = z.infer<typeof AppStatisticsSchema>;
