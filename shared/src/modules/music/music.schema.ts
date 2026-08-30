import { z } from 'zod';

export const MusicRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string().optional(),
  })
  .passthrough();

export const MusicListSchema = z.array(MusicRowSchema);

export const MusicAliasEntrySchema = z.object({
  musicId: z.string(),
  aliases: z.array(z.string()),
});

export const MusicAliasListResponseSchema = z.object({
  revision: z.string().datetime().nullable(),
  aliases: z.array(MusicAliasEntrySchema),
});

export type MusicAliasEntry = z.infer<typeof MusicAliasEntrySchema>;
export type MusicAliasListResponse = z.infer<
  typeof MusicAliasListResponseSchema
>;

export const MusicSyncResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

export const MusicAliasSyncResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();
