import { z } from 'zod';

export const MusicDataSourceSchema = z.enum(['diving-fish', 'lxns']);

export const MusicRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string().optional(),
  })
  .passthrough();

export const MusicListSchema = z.array(MusicRowSchema);

export const MusicSourceResponseSchema = z.object({
  source: MusicDataSourceSchema,
});

export const SetMusicSourceBodySchema = z.object({
  source: MusicDataSourceSchema,
});

export const MusicSyncResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

export type SetMusicSourceBody = z.infer<typeof SetMusicSourceBodySchema>;
