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
    cabinetUserId: z.number().int().nullable().optional(),
    autoUpdate: z.boolean().optional(),
    lastScoreHash: z.string().nullable().optional(),
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

/**
 * Cabinet QR binding — both shapes are accepted by the same endpoint.
 *  - JSON body  : { qrCode: "SGWCMAID..." }
 *  - multipart  : field `image` (PNG/JPG of the player's card QR)
 *
 * On success returns { ok: true, cabinetUserId }.
 * On id-mismatch (fewer than 5 score rows match), HTTP 409 with
 *   { error: "user id not match" }.
 */
export const BindCabinetQrBodySchema = z.object({
  qrCode: z.string().min(1).optional(),
});

export const BindCabinetQrResponseSchema = z.object({
  ok: z.literal(true),
  cabinetUserId: z.number().int().positive(),
});

export const SetAutoUpdateBodySchema = z.object({
  enabled: z.boolean(),
});

export const SetAutoUpdateResponseSchema = z.object({
  ok: z.literal(true),
  autoUpdate: z.boolean(),
});

export type BindCabinetQrBody = z.infer<typeof BindCabinetQrBodySchema>;
export type SetAutoUpdateBody = z.infer<typeof SetAutoUpdateBodySchema>;
