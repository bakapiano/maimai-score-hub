import { z } from "zod";

import { WebAuthnJsonSchema } from "../auth/auth.schema";

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

export const PasskeyNameSchema = z.string().trim().min(1).max(50);

export const PasskeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  transports: z.array(z.string()),
  deviceType: z.enum(["singleDevice", "multiDevice"]),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

export const PasskeyRegistrationOptionsBodySchema = z.object({
  password: z.string().min(1).max(72),
});

export const PasskeyRegistrationOptionsResponseSchema = z.object({
  ceremonyId: z.string().uuid(),
  options: WebAuthnJsonSchema,
});

export const PasskeyRegistrationVerifyBodySchema = z.object({
  ceremonyId: z.string().uuid(),
  name: PasskeyNameSchema,
  response: WebAuthnJsonSchema,
});

export const RenamePasskeyBodySchema = z.object({
  name: PasskeyNameSchema,
});

export const DeletePasskeyBodySchema = z.object({
  password: z.string().min(1).max(72),
});

export type PasskeySummary = z.infer<typeof PasskeySummarySchema>;
export type PasskeyRegistrationOptionsBody = z.infer<
  typeof PasskeyRegistrationOptionsBodySchema
>;
export type PasskeyRegistrationVerifyBody = z.infer<
  typeof PasskeyRegistrationVerifyBodySchema
>;
export type RenamePasskeyBody = z.infer<typeof RenamePasskeyBodySchema>;
export type DeletePasskeyBody = z.infer<typeof DeletePasskeyBodySchema>;

/**
 * Cabinet QR binding — both shapes are accepted by the same endpoint.
 *  - JSON body  : { qrCode: "SGWCMAID..." }
 *  - multipart  : field `image` (PNG/JPG of the player's card QR)
 *
 * With 4+ stored scores, identity requires every row to match up to a maximum
 * of 10 rows. With fewer than 4 scores, binding uses the same name + B50
 * rating reverse lookup as QR login. Mismatches return HTTP 409.
 */
export const BindCabinetQrBodySchema = z.object({
  qrCode: z.string().min(1).optional(),
});

export const BindCabinetQrResponseSchema = z.object({
  ok: z.literal(true),
});

export const BindCabinetQrMismatchSchema = z.object({
  error: z.string(),
  verification: z.enum(["scores", "profile"]),
  matchedRows: z.number().int().nonnegative(),
  requiredRows: z.number().int().positive().nullable(),
});

export type BindCabinetQrBody = z.infer<typeof BindCabinetQrBodySchema>;
