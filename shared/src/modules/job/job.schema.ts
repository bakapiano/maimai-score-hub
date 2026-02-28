import { z } from "zod";

export const JobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "canceled",
]);

export const JobStageSchema = z.enum([
  "send_request",
  "wait_acceptance",
  "update_score",
]);

export const JobTypeSchema = z.enum([
  "immediate",
  "idle_add_friend",
  "idle_update_score",
]);

export const ScoreProgressSchema = z.object({
  completedDiffs: z.array(z.number().int().min(0).max(14)),
  totalDiffs: z.number().int().min(1),
});

export const AutoExportResultSchema = z
  .object({
    divingFish: z
      .object({ status: z.string(), message: z.string().optional() })
      .nullable()
      .optional(),
    lxns: z
      .object({ status: z.string(), message: z.string().optional() })
      .nullable()
      .optional(),
  })
  .nullable()
  .optional();

export const JobResponseSchema = z.object({
  id: z.string(),
  friendCode: z.string(),
  jobType: JobTypeSchema,
  skipUpdateScore: z.boolean(),
  botUserFriendCode: z.string().nullable().optional(),
  friendRequestSentAt: z.string().nullable().optional(),
  status: JobStatusSchema,
  stage: JobStageSchema,
  profile: z.unknown().optional(),
  error: z.string().nullable().optional(),
  executing: z.boolean().optional(),
  scoreProgress: ScoreProgressSchema.nullable().optional(),
  updateScoreDuration: z.number().nullable().optional(),
  autoExportResult: AutoExportResultSchema,
  isAuthenticated: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const JobCreateBodySchema = z.object({
  friendCode: z.string().min(1),
  skipUpdateScore: z.boolean().optional().default(false),
});

export const JobCreateResponseSchema = z.object({
  jobId: z.string(),
  job: JobResponseSchema,
});

export const JobByFriendCodeActiveResponseSchema = z.object({
  job: JobResponseSchema.nullable(),
});

export const JobPatchBodySchema = z.object({
  botUserFriendCode: z.string().nullable().optional(),
  status: JobStatusSchema.optional(),
  stage: JobStageSchema.optional(),
  result: z.unknown().optional(),
  profile: z.unknown().optional(),
  error: z.string().nullable().optional(),
  friendRequestSentAt: z.string().nullable().optional(),
  executing: z.boolean().optional(),
  updatedAt: z.string().optional(),
  scoreProgress: ScoreProgressSchema.nullable().optional(),
  addCompletedDiff: z.number().int().min(0).optional(),
  updateScoreDuration: z.number().nullable().optional(),
});

export const JobNextBodySchema = z.object({
  botUserFriendCode: z.string().min(1),
});

export const JobRecentStatsSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  successRate: z.number(),
  avgDuration: z.number().nullable(),
});

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobStage = z.infer<typeof JobStageSchema>;
export type JobType = z.infer<typeof JobTypeSchema>;
export type ScoreProgress = z.infer<typeof ScoreProgressSchema>;
export type JobResponse = z.infer<typeof JobResponseSchema>;
export type JobCreateBody = z.infer<typeof JobCreateBodySchema>;
export type JobCreateResponse = z.infer<typeof JobCreateResponseSchema>;
export type JobPatchBody = z.infer<typeof JobPatchBodySchema>;
export type JobNextBody = z.infer<typeof JobNextBodySchema>;
export type JobRecentStats = z.infer<typeof JobRecentStatsSchema>;
