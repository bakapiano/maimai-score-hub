import { z } from 'zod';

import { JobCreateResponseSchema } from '../job/job.schema';

export const LoginRequestBodySchema = z.object({
  friendCode: z.string().min(1),
  skipUpdateScore: z.boolean().optional().default(true),
  method: z.enum(["bot_sends_request", "user_sends_request"]),
});

export const LoginRequestResponseSchema = z
  .object({
    jobId: z.string(),
    authUrl: z.string().optional(),
    authToken: z.string().optional(),
    message: z.string().optional(),
    reused: z.boolean().optional(),
    botFriendCode: z.string().optional(),
    createdAt: z.string().optional(),
    job: JobCreateResponseSchema.shape.job.optional(),
  })
  .passthrough();

export const LoginRequestVerifyResponseSchema = z.object({
  job: JobCreateResponseSchema.shape.job,
});

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

/**
 * QR-code login. Body accepts EITHER multipart with field `image`
 * (handled at controller level, not in this zod schema) OR JSON
 * `{ qrCode }` with the SGWCMAID... string.
 */
export const LoginByQrBodySchema = z.object({
  qrCode: z.string().min(1).optional(),
});

export const LoginByQrResponseSchema = z.object({
  token: z.string(),
  user: z
    .object({
      id: z.string().optional(),
      friendCode: z.string(),
    })
    .passthrough(),
});

export type LoginByQrBody = z.infer<typeof LoginByQrBodySchema>;
