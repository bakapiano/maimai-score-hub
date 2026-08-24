import { z } from "zod";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const AndroidAppReleaseChannelSchema = z.enum([
  "debug",
  "beta",
  "stable",
]);

export const AndroidAppReleaseIdSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]+$/);

export const AndroidAppPackageNameSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/);

export const AndroidAppDownloadHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/);

export const AndroidAppReleaseManifestSchema = z
  .object({
    releaseId: AndroidAppReleaseIdSchema,
    channel: AndroidAppReleaseChannelSchema,
    packageName: AndroidAppPackageNameSchema,
    versionCode: z.number().int().positive(),
    versionName: z.string().min(1).max(80),
    requiredBridgeApiVersion: z.number().int().positive(),
    minSdk: z.number().int().min(26).max(100),
    apkUrl: z.string().url().max(2048),
    apkSha256: z.string().regex(SHA256_PATTERN),
    apkSize: z.number().int().positive().max(50 * 1024 * 1024),
    certificateSha256: z.string().regex(SHA256_PATTERN),
    downloadHosts: z.array(AndroidAppDownloadHostSchema).min(1).max(16),
    mandatory: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    notes: z.string().max(4000),
    publishedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const AndroidAppReleaseEnvelopeSchema = z
  .object({
    manifestBase64: z.string().min(4).max(64 * 1024).regex(BASE64_PATTERN),
    signatureBase64: z.string().min(4).max(16 * 1024).regex(BASE64_PATTERN),
    signatureAlgorithm: z.literal("SHA256withRSA"),
  })
  .strict();

export const AndroidAppReleasePolicySchema = z
  .object({
    channel: AndroidAppReleaseChannelSchema,
    packageName: AndroidAppPackageNameSchema,
    certificateSha256: z.string().regex(SHA256_PATTERN),
    manifestPublicKeyBase64: z
      .string()
      .min(64)
      .max(16 * 1024)
      .regex(BASE64_PATTERN),
    allowedDownloadHosts: z
      .array(AndroidAppDownloadHostSchema)
      .min(1)
      .max(16),
    maxApkBytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    enabled: z.boolean(),
  })
  .strict();

export const AndroidAppReleaseInfoSchema = AndroidAppReleaseManifestSchema.pick({
  releaseId: true,
  channel: true,
  packageName: true,
  versionCode: true,
  versionName: true,
  requiredBridgeApiVersion: true,
  apkSize: true,
  mandatory: true,
  rolloutPercent: true,
  notes: true,
  publishedAt: true,
});

export const AndroidAppReleaseLatestQuerySchema = z.object({
  channel: AndroidAppReleaseChannelSchema,
  packageName: AndroidAppPackageNameSchema,
  currentVersionCode: z.coerce.number().int().nonnegative(),
  installationId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/),
});

export const AndroidAppReleaseLatestResponseSchema = z
  .object({
    updateAvailable: z.boolean(),
    release: AndroidAppReleaseInfoSchema.nullable(),
  })
  .strict();

export type AndroidAppReleaseChannel = z.infer<
  typeof AndroidAppReleaseChannelSchema
>;
export type AndroidAppReleaseManifest = z.infer<
  typeof AndroidAppReleaseManifestSchema
>;
export type AndroidAppReleaseEnvelope = z.infer<
  typeof AndroidAppReleaseEnvelopeSchema
>;
export type AndroidAppReleasePolicy = z.infer<
  typeof AndroidAppReleasePolicySchema
>;
export type AndroidAppReleaseInfo = z.infer<
  typeof AndroidAppReleaseInfoSchema
>;
export type AndroidAppReleaseLatestQuery = z.infer<
  typeof AndroidAppReleaseLatestQuerySchema
>;
export type AndroidAppReleaseLatestResponse = z.infer<
  typeof AndroidAppReleaseLatestResponseSchema
>;
