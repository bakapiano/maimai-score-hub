import { z } from 'zod';

export const LastSyncSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    scores: z.array(z.unknown()).optional(),
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
