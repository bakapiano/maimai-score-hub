import { z } from "zod";

export const LastSyncSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastMergedAt: z.string().optional(),
    scoreUpdatedAt: z.string().optional(),
    scoreVersion: z.number().int().nonnegative().optional(),
    scores: z.array(z.unknown()).optional(),
    autoExportResult: z
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
      .optional(),
    proberExportState: z
      .object({
        providers: z.object({
          divingFish: z.object({
            enabled: z.boolean(),
            lastSuccessVersion: z.number().int().nonnegative().nullable(),
            status: z.enum(["idle", "processing", "failed"]),
            error: z.string().nullable(),
            updatedAt: z.string().nullable(),
          }),
          lxns: z.object({
            enabled: z.boolean(),
            lastSuccessVersion: z.number().int().nonnegative().nullable(),
            status: z.enum(["idle", "processing", "failed"]),
            error: z.string().nullable(),
            updatedAt: z.string().nullable(),
          }),
        }),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export const ExportResultSchema = z
  .object({
    success: z.boolean().optional(),
    message: z.string().optional(),
    scores: z.number().optional(),
    exported: z.number().optional(),
    response: z.unknown().optional(),
  })
  .passthrough();

export const ProberExportProviderSchema = z.enum(["divingFish", "lxns"]);
export const ProberExportStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "partial_failed",
  "failed",
  "skipped",
]);
export const ProberExportProviderResultSchema = z
  .object({
    status: z.enum(["success", "failed", "skipped"]),
    exported: z.number().optional(),
    skipped: z.number().optional(),
    scores: z.number().optional(),
    message: z.string().optional(),
    response: z.unknown().optional(),
  })
  .passthrough();

export const ProberExportResultSchema = z
  .object({
    divingFish: ProberExportProviderResultSchema.nullable().optional(),
    lxns: ProberExportProviderResultSchema.nullable().optional(),
  })
  .nullable();

export const ProberExportJobSchema = z
  .object({
    id: z.string(),
    trigger: z.enum([
      "dxnet_update_score",
      "auto_update_rival",
      "auto_update_fcfs",
      "cabinet_qr_update",
      "auto_latest",
      "manual",
    ]),
    kind: z.enum(["auto", "manual"]).optional(),
    friendCode: z.string(),
    syncId: z.string(),
    requestedScoreVersion: z.number().int().nonnegative().nullable().optional(),
    exportedScoreVersion: z.number().int().nonnegative().nullable().optional(),
    sourceJobId: z.string().nullable(),
    sourceTaskId: z.string().nullable(),
    targets: z.array(ProberExportProviderSchema),
    status: ProberExportStatusSchema,
    attempts: z.number(),
    result: ProberExportResultSchema,
    error: z.string().nullable(),
    claimedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const ProberExportCreateResponseSchema = z.object({
  exportJobId: z.string(),
  status: ProberExportStatusSchema,
  job: ProberExportJobSchema,
});

export const ProberExportListResponseSchema = z.object({
  items: z.array(ProberExportJobSchema),
});

export type ProberExportProvider = z.infer<typeof ProberExportProviderSchema>;
export type ProberExportJob = z.infer<typeof ProberExportJobSchema>;

export const CabinetScoreJobCreateBodySchema = z
  .object({
    qrCode: z.string().trim().min(1).max(512),
  })
  .strict();

export const CabinetScoreJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);
export const CabinetScoreJobStageSchema = z.enum([
  "queued",
  "qr_auth",
  "preview",
  "login",
  "get_music",
  "logout",
  "cleanup",
  "persist",
]);
export const CabinetScoreCleanupStatusSchema = z.enum([
  "not_required",
  "pending",
  "succeeded",
  "unconfirmed",
]);

export const CabinetScoreJobSchema = z.object({
  id: z.string(),
  method: z.literal("cabinet_qr"),
  status: CabinetScoreJobStatusSchema,
  stage: CabinetScoreJobStageSchema,
  cleanupStatus: CabinetScoreCleanupStatusSchema,
  progress: z
    .object({ detailsFetched: z.number().int().nonnegative() })
    .nullable(),
  syncId: z.string().nullable(),
  scoreCount: z.number().int().nonnegative().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryAfter: z.string().optional(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CabinetScoreJobCreateResponseSchema = z.object({
  jobId: z.string(),
  job: CabinetScoreJobSchema,
});

export const CabinetScoreActiveJobSchema = z.object({
  job: CabinetScoreJobSchema.nullable(),
});

export type CabinetScoreJobCreateBody = z.infer<
  typeof CabinetScoreJobCreateBodySchema
>;
export type CabinetScoreJob = z.infer<typeof CabinetScoreJobSchema>;

export const ScoreChangeSourceTypeSchema = z.enum([
  "dxnet_update_score",
  "auto_update_rival",
  "auto_update_fcfs",
  "cabinet_qr_update",
]);

export const ScoreChangeFieldSchema = z.enum([
  "score",
  "dxScore",
  "fc",
  "fs",
  "rating",
  "newChart",
]);

export const ScoreChangeValueSchema = z.object({
  score: z.string().nullable().optional(),
  dxScore: z.string().nullable().optional(),
  fc: z.string().nullable().optional(),
  fs: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
});

export const ScoreChangeSchema = z.object({
  id: z.string(),
  observedAt: z.string().datetime(),
  sourceType: ScoreChangeSourceTypeSchema,
  beforeScoreVersion: z.number().int().nonnegative().nullable(),
  afterScoreVersion: z.number().int().nonnegative(),
  musicId: z.string(),
  chartIndex: z.number().int().nonnegative(),
  type: z.string(),
  before: ScoreChangeValueSchema,
  after: ScoreChangeValueSchema,
  changedFields: z.array(ScoreChangeFieldSchema),
  achievementDelta: z.number().nullable(),
  dxScoreDelta: z.number().nullable(),
  ratingDelta: z.number().nullable(),
  fcRankDelta: z.number().int().nullable(),
  fsRankDelta: z.number().int().nullable(),
});

export const ScoreChangeHistoryQuerySchema = z
  .object({
    musicId: z.string().trim().min(1).max(64),
    chartIndex: z.coerce.number().int().min(0).max(10),
    type: z.string().trim().min(1).max(32),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const ScoreChangeHistoryResponseSchema = z.object({
  items: z.array(ScoreChangeSchema),
  nextCursor: z.string().nullable(),
});

export const ScoreHistoryFeedQuerySchema = z
  .object({
    start: z.coerce
      .number()
      .int()
      .min(0)
      .max(8_640_000_000_000_000),
    end: z.coerce
      .number()
      .int()
      .min(0)
      .max(8_640_000_000_000_000),
  })
  .strict()
  .refine((query) => query.start < query.end, {
    message: "start must be earlier than end",
  })
  .refine((query) => query.end - query.start <= 100 * 24 * 60 * 60 * 1000, {
    message: "history range cannot exceed 100 days",
  });

export const ScoreHistoryFeedResponseSchema = z.object({
  items: z.array(ScoreChangeSchema),
  hasEarlier: z.boolean(),
});

export const ScoreHistoryCalendarQuerySchema = z
  .object({
    from: z.coerce.number().int().min(0).max(8_640_000_000_000_000),
    to: z.coerce.number().int().min(0).max(8_640_000_000_000_000),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_+\-/]+$/),
    dayStartHour: z.coerce.number().int().min(0).max(23).default(6),
  })
  .strict()
  .refine((query) => query.from < query.to, {
    message: "from must be earlier than to",
  })
  .refine((query) => query.to - query.from <= 370 * 24 * 60 * 60 * 1000, {
    message: "calendar range cannot exceed 370 days",
  });

export const ScoreHistoryCalendarResponseSchema = z.object({
  days: z.array(
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      count: z.number().int().positive(),
    }),
  ),
  hasEarlier: z.boolean(),
});

export type ScoreChangeSourceType = z.infer<typeof ScoreChangeSourceTypeSchema>;
export type ScoreChangeField = z.infer<typeof ScoreChangeFieldSchema>;
export type ScoreChangeValue = z.infer<typeof ScoreChangeValueSchema>;
export type ScoreChange = z.infer<typeof ScoreChangeSchema>;
export type ScoreChangeHistoryQuery = z.infer<
  typeof ScoreChangeHistoryQuerySchema
>;
export type ScoreChangeHistoryResponse = z.infer<
  typeof ScoreChangeHistoryResponseSchema
>;
export type ScoreHistoryFeedQuery = z.infer<
  typeof ScoreHistoryFeedQuerySchema
>;
export type ScoreHistoryFeedResponse = z.infer<
  typeof ScoreHistoryFeedResponseSchema
>;
export type ScoreHistoryCalendarQuery = z.infer<
  typeof ScoreHistoryCalendarQuerySchema
>;
export type ScoreHistoryCalendarResponse = z.infer<
  typeof ScoreHistoryCalendarResponseSchema
>;
