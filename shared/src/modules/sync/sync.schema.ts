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
