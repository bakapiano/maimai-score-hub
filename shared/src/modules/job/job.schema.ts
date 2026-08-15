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

export const DxnetJobSourceSchema = z.enum([
  "user_interaction",
  "user_sync",
  "qr_login",
  "cabinet_binding",
  "auto_update",
  "maintenance",
]);

export const DxnetExecutionLaneSchema = z.enum([
  "interactive",
  "user_sync",
  "background",
]);

export const DxnetAssignmentModeSchema = z.enum(["claim", "pinned"]);
export const DxnetDeliveryModeSchema = z.enum(["shared", "pinned"]);

export const DxnetJobRoutingSchema = z.object({
  version: z.literal(2),
  deliveryEpoch: z.number().int().positive(),
  source: DxnetJobSourceSchema,
  lane: DxnetExecutionLaneSchema,
  assignmentMode: DxnetAssignmentModeSchema,
  deliveryMode: DxnetDeliveryModeSchema,
});

export const DxnetExecutionRequestSchema = z.object({
  deliveryEpoch: z.number().int().positive(),
  attemptsStarted: z.number().int().positive(),
  queueName: z.string().min(1),
  workerId: z.string().min(1),
});

export const DxnetExecutionSchema = DxnetExecutionRequestSchema.omit({
  queueName: true,
}).extend({
  startedAt: z.string(),
});

export const CabinetFriendshipStatusSchema = z.enum([
  "not_required",
  "pending",
  "running",
  "ready",
  "uncertain",
  "failed",
]);

export const DxnetJobErrorCodeSchema = z.enum([
  "cabinet_bot_unavailable",
  "cabinet_friendship_failed",
  "cabinet_friendship_unconfirmed",
  "job_deadline_exceeded",
]);

export const ScoreProgressSchema = z.object({
  completedDiffs: z.array(z.number().int().min(0).max(14)),
  totalDiffs: z.number().int().min(0),
});

const JobResponseBaseSchema = z.object({
  id: z.string(),
  jobType: JobTypeSchema,
  priority: z.number().int().min(0).max(4).optional(),
  botUserFriendCode: z.string().nullable().optional(),
  friendRequestSentAt: z.string().nullable().optional(),
  friendRequestWaitStartedAt: z.string().nullable().optional(),
  status: JobStatusSchema,
  stage: JobStageSchema,
  profile: z.unknown().optional(),
  error: z.string().nullable().optional(),
  errorCode: DxnetJobErrorCodeSchema.nullable().optional(),
  scoreProgress: ScoreProgressSchema.nullable().optional(),
  updateScoreDuration: z.number().nullable().optional(),
  diffsToScrape: z.array(z.number().int()).nullable().optional(),
  context: z.record(z.unknown()).nullable().optional(),
  runAt: z.string().nullable().optional(),
  deadlineAt: z.string().nullable().optional(),
  cabinetFriendshipStatus: CabinetFriendshipStatusSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Public `/me` shape. A user job always has a concrete friend code. */
export const PublicJobResponseSchema = JobResponseBaseSchema.extend({
  friendCode: z.string().min(1),
});

/** Worker shape additionally exposes routing/fencing state and internal null FC. */
export const WorkerJobResponseSchema = JobResponseBaseSchema.extend({
  friendCode: z.string().nullable(),
  result: z.unknown().optional(),
  routing: DxnetJobRoutingSchema.nullable().optional(),
  execution: DxnetExecutionSchema.nullable().optional(),
});

/** Default public response alias. */
export const JobResponseSchema = PublicJobResponseSchema;

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
  errorCode: DxnetJobErrorCodeSchema.nullable().optional(),
  friendRequestSentAt: z.string().nullable().optional(),
  friendRequestWaitStartedAt: z.string().nullable().optional(),
  runAt: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  scoreProgress: ScoreProgressSchema.nullable().optional(),
  addCompletedDiff: z.number().int().min(0).optional(),
  updateScoreDuration: z.number().nullable().optional(),
  execution: DxnetExecutionRequestSchema,
  /** Atomic shared-to-pinned continuation; backend increments deliveryEpoch. */
  handoff: z
    .object({
      deliveryMode: z.literal("pinned"),
      runAt: z.string().datetime(),
    })
    .optional(),
});

export const PrepareCabinetFriendshipBodySchema = z.object({
  execution: DxnetExecutionRequestSchema.omit({ queueName: true }),
});

export const PrepareCabinetFriendshipResponseSchema = z.object({
  status: CabinetFriendshipStatusSchema,
});

export const DxnetWorkerMutationErrorSchema = z.object({
  code: z.enum([
    "stale_execution",
    "bot_ineligible",
    "invalid_route",
    "job_terminal",
    "bot_assignment_busy",
  ]),
  reason: z
    .enum([
      "heartbeat",
      "allowlist",
      "cabinet_binding",
      "snapshot_stale",
      "capacity",
    ])
    .optional(),
  message: z.string().optional(),
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
export type DxnetJobSource = z.infer<typeof DxnetJobSourceSchema>;
export type DxnetExecutionLane = z.infer<typeof DxnetExecutionLaneSchema>;
export type DxnetAssignmentMode = z.infer<typeof DxnetAssignmentModeSchema>;
export type DxnetDeliveryMode = z.infer<typeof DxnetDeliveryModeSchema>;
export type DxnetJobRouting = z.infer<typeof DxnetJobRoutingSchema>;
export type DxnetExecutionRequest = z.infer<typeof DxnetExecutionRequestSchema>;
export type DxnetExecution = z.infer<typeof DxnetExecutionSchema>;
export type CabinetFriendshipStatus = z.infer<
  typeof CabinetFriendshipStatusSchema
>;
export type DxnetJobErrorCode = z.infer<typeof DxnetJobErrorCodeSchema>;
export type ScoreProgress = z.infer<typeof ScoreProgressSchema>;
export type JobResponse = z.infer<typeof JobResponseSchema>;
export type PublicJobResponse = z.infer<typeof PublicJobResponseSchema>;
export type WorkerJobResponse = z.infer<typeof WorkerJobResponseSchema>;
export type JobCreateBody = z.infer<typeof JobCreateBodySchema>;
export type JobCreateResponse = z.infer<typeof JobCreateResponseSchema>;
export type JobFriendshipStatusResponse = z.infer<
  typeof JobFriendshipStatusResponseSchema
>;
export type JobVerifyResponse = z.infer<typeof JobVerifyResponseSchema>;
export type JobPatchBody = z.infer<typeof JobPatchBodySchema>;
export type PrepareCabinetFriendshipBody = z.infer<
  typeof PrepareCabinetFriendshipBodySchema
>;
export type JobRecentStats = z.infer<typeof JobRecentStatsSchema>;
