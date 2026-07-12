import { z } from "zod";

export const LastSyncSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
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
      "manual",
    ]),
    friendCode: z.string(),
    syncId: z.string(),
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
