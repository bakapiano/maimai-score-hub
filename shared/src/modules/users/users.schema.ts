import { z } from "zod";

export const UserProfileSchema = z
  .object({
    id: z.string(),
    friendCode: z.string(),
    username: z.string().nullable().optional(),
    hasPassword: z.boolean().optional(),
    hasDivingFishImportToken: z.boolean().optional(),
    hasLxnsImportToken: z.boolean().optional(),
    profile: z.unknown().nullable().optional(),
    hasCabinetUserId: z.boolean().optional(),
    autoUpdate: z.boolean().optional(),
  })
  .passthrough();

export const UpdateProfileBodySchema = z.object({
  divingFishImportToken: z.string().nullable().optional(),
  lxnsImportToken: z.string().nullable().optional(),
  autoUpdate: z.boolean().optional(),
});

export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_]+$/)
  .refine((value) => !/^\d{15}$/.test(value), {
    message: "username cannot be a 15-digit friendCode",
  });

export const AccountPasswordSchema = z.string().min(8).max(72);

export const SetAccountPasswordBodySchema = z
  .object({
    username: UsernameSchema.optional(),
    currentPassword: z.string().min(1).max(72).optional(),
    newPassword: AccountPasswordSchema.optional(),
  })
  .refine(
    (body) => body.username !== undefined || body.newPassword !== undefined,
    {
      message: "username or newPassword is required",
    },
  );

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
export type SetAccountPasswordBody = z.infer<
  typeof SetAccountPasswordBodySchema
>;
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
