import { z } from 'zod';

export const OkSchema = z.object({ ok: z.boolean() });
export const MessageSchema = z.object({ message: z.string() });
export const HealthSchema = z.object({ status: z.string() });

export const PagingQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(10),
});
