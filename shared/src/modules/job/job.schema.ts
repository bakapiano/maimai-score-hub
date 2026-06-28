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
  "wait_user_request",
  "accept_request",
  "update_score",
  "get_user_recent_event",
  "get_full_friend_list",
]);

export const JobTypeSchema = z.enum([
  "send_friend_request",
  "accept_friend_request",
  "update_score",
  "get_user_recent_event",
  "get_full_friend_list",
]);

export const ScoreProgressSchema = z.object({
  completedDiffs: z.array(z.number().int().min(0).max(14)),
  totalDiffs: z.number().int().min(0),
});

export const JobResponseSchema = z.object({
  id: z.string(),
  friendCode: z.string(),
  jobType: JobTypeSchema,
  priority: z.number().int().optional(),
  botUserFriendCode: z.string().nullable().optional(),
  friendRequestSentAt: z.string().nullable().optional(),
  friendRequestWaitStartedAt: z.string().nullable().optional(),
  status: JobStatusSchema,
  stage: JobStageSchema,
  profile: z.unknown().optional(),
  error: z.string().nullable().optional(),
  scoreProgress: ScoreProgressSchema.nullable().optional(),
  updateScoreDuration: z.number().nullable().optional(),
  diffsToScrape: z.array(z.number().int()).nullable().optional(),
  context: z.record(z.unknown()).nullable().optional(),
  removeFriendAfterComplete: z.boolean().optional(),
  runAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const JobCreateBodySchema = z.object({
  jobType: z
    .enum(["update_score", "send_friend_request"])
    .optional()
    .default("update_score"),
  /**
   * Optional proof from a just-completed send_friend_request job. This lets the
   * frontend immediately start update_score even before the next bot friend
   * snapshot heartbeat lands.
   */
  friendshipJobId: z.string().optional(),
});

export const JobCreateResponseSchema = z.object({
  jobId: z.string(),
  job: JobResponseSchema,
});

export const JobByFriendCodeActiveResponseSchema = z.object({
  job: JobResponseSchema.nullable(),
});

export const JobFriendshipStatusResponseSchema = z.object({
  isFriend: z.boolean(),
  hasCabinetUserId: z.boolean(),
  botFriendCode: z.string().nullable(),
  recommendedBotFriendCode: z.string().nullable(),
  availableBotCount: z.number().int().nonnegative(),
  friendsUpdatedAt: z.string().nullable(),
  checkedAt: z.string(),
});

export const JobVerifyResponseSchema = z.object({
  job: JobResponseSchema,
});

export const JobPatchBodySchema = z.object({
  botUserFriendCode: z.string().nullable().optional(),
  status: JobStatusSchema.optional(),
  stage: JobStageSchema.optional(),
  result: z.unknown().optional(),
  profile: z.unknown().optional(),
  error: z.string().nullable().optional(),
  friendRequestSentAt: z.string().nullable().optional(),
  friendRequestWaitStartedAt: z.string().nullable().optional(),
  runAt: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  scoreProgress: ScoreProgressSchema.nullable().optional(),
  addCompletedDiff: z.number().int().min(0).optional(),
  updateScoreDuration: z.number().nullable().optional(),
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
export type JobFriendshipStatusResponse = z.infer<
  typeof JobFriendshipStatusResponseSchema
>;
export type JobVerifyResponse = z.infer<typeof JobVerifyResponseSchema>;
export type JobPatchBody = z.infer<typeof JobPatchBodySchema>;
export type JobRecentStats = z.infer<typeof JobRecentStatsSchema>;
