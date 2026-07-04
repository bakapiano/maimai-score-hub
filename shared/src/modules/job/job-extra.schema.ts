import { z } from "zod";

export const TempCachePathSchema = z.object({
  jobId: z.string(),
  diff: z.coerce.number().int(),
  type: z.coerce.number().int(),
});

export const ChartTypeSchema = z.enum(["standard", "dx", "utage"]);

export const FriendVsSongSchema = z.object({
  level: z.string(),
  name: z.string(),
  score: z.string().nullable(),
  category: z.string().nullable(),
  type: ChartTypeSchema,
  fs: z.string().nullable(),
  fc: z.string().nullable(),
});

export const TempCacheBodySchema = z.object({
  songs: z.array(FriendVsSongSchema),
});

export const TempCacheResponseSchema = z.object({
  songs: z.array(FriendVsSongSchema),
});

export type TempCachePath = z.infer<typeof TempCachePathSchema>;
export type FriendVsSong = z.infer<typeof FriendVsSongSchema>;
export type TempCacheBody = z.infer<typeof TempCacheBodySchema>;
