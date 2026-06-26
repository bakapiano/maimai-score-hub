import { z } from 'zod';

export const MusicRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string().optional(),
  })
  .passthrough();

export const MusicListSchema = z.array(MusicRowSchema);

export const MusicSyncResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();
