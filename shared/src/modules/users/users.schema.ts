import { z } from "zod";

export const UserProfileSchema = z
  .object({
    id: z.string(),
    friendCode: z.string(),
    hasDivingFishImportToken: z.boolean().optional(),
    hasLxnsImportToken: z.boolean().optional(),
    profile: z.unknown().nullable().optional(),
    autoExportDivingFish: z.boolean().optional(),
    autoExportLxns: z.boolean().optional(),
    hasCabinetUserId: z.boolean().optional(),
    autoUpdate: z.boolean().optional(),
    lastScoreHash: z.string().nullable().optional(),
  })
  .passthrough();

export const UpdateProfileBodySchema = z.object({
  divingFishImportToken: z.string().nullable().optional(),
  lxnsImportToken: z.string().nullable().optional(),
  autoExportDivingFish: z.boolean().optional(),
  autoExportLxns: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
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
});

export type BindCabinetQrBody = z.infer<typeof BindCabinetQrBodySchema>;
