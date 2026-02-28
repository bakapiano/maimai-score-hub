import { JobResponseSchema } from "../job/job.schema";
import { z } from "zod";

export const UserProfileSchema = z
  .object({
    id: z.string(),
    friendCode: z.string(),
    hasDivingFishImportToken: z.boolean().optional(),
    hasLxnsImportToken: z.boolean().optional(),
    profile: z.unknown().nullable().optional(),
    idleUpdateBotFriendCode: z.string().nullable().optional(),
    autoExportDivingFish: z.boolean().optional(),
    autoExportLxns: z.boolean().optional(),
  })
  .passthrough();

export const UpdateProfileBodySchema = z.object({
  divingFishImportToken: z.string().nullable().optional(),
  lxnsImportToken: z.string().nullable().optional(),
  autoExportDivingFish: z.boolean().optional(),
  autoExportLxns: z.boolean().optional(),
});

export const DivingFishTokenBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const DivingFishTokenResponseSchema = z
  .object({
    token: z.string().optional(),
    importToken: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const IdleUpdateStatusSchema = z.object({
  enabled: z.boolean(),
  botFriendCode: z.string().nullable(),
  pendingJob: z.boolean(),
  activeJob: JobResponseSchema.nullable().optional(),
});

export const IdleUpdateEnableResponseSchema = z
  .object({
    jobId: z.string().optional(),
    job: JobResponseSchema.optional(),
    message: z.string(),
  })
  .passthrough();

export const IdleUpdateDisableResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

export type UpdateProfileBody = z.infer<typeof UpdateProfileBodySchema>;
export type DivingFishTokenBody = z.infer<typeof DivingFishTokenBodySchema>;
