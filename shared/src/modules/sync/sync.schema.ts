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
