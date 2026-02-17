import { z } from 'zod';

export const IdleUpdateMarkReadyBodySchema = z.object({
  friendCode: z.string().min(1),
  botFriendCode: z.string().min(1),
});

export const TempCachePathSchema = z.object({
  jobId: z.string(),
  diff: z.coerce.number().int(),
  type: z.coerce.number().int(),
});

export const TempCacheBodySchema = z.object({
  html: z.string(),
});

export const TempCacheResponseSchema = z.object({ html: z.string() });

export const ApiLogEntrySchema = z.object({
  url: z.string(),
  method: z.string(),
  statusCode: z.number(),
  responseBody: z.string().nullable().optional(),
});

export const AddApiLogsBodySchema = z.object({
  logs: z.array(ApiLogEntrySchema),
});

export type IdleUpdateMarkReadyBody = z.infer<
  typeof IdleUpdateMarkReadyBodySchema
>;
export type TempCachePath = z.infer<typeof TempCachePathSchema>;
export type TempCacheBody = z.infer<typeof TempCacheBodySchema>;
export type AddApiLogsBody = z.infer<typeof AddApiLogsBodySchema>;
