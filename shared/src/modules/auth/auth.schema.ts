import { z } from 'zod';

import { JobCreateResponseSchema } from '../job/job.schema';

export const LoginRequestBodySchema = z.object({
  friendCode: z.string().min(1),
  skipUpdateScore: z.boolean().optional().default(true),
  useIdleUpdate: z.boolean().optional().default(false),
});

export const LoginRequestResponseSchema = z
  .object({
    jobId: z.string(),
    authUrl: z.string().optional(),
    authToken: z.string().optional(),
    message: z.string().optional(),
    reused: z.boolean().optional(),
    idleUpdate: z.boolean().optional(),
    job: JobCreateResponseSchema.shape.job.optional(),
  })
  .passthrough();

export const LoginStatusQuerySchema = z.object({
  jobId: z.string().min(1),
});

export const LoginStatusResponseSchema = z
  .object({
    done: z.boolean().optional(),
    status: z.string().optional(),
    friendCode: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export type LoginRequestBody = z.infer<typeof LoginRequestBodySchema>;
export type LoginStatusQuery = z.infer<typeof LoginStatusQuerySchema>;
