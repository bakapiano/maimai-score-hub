import { z } from "zod";

export const MusicDetailSchema = z.object({
  level: z.number().int(),
  achievement: z.number().int(),
  deluxscoreMax: z.number().int(),
});

export const MusicEntrySchema = z.object({
  musicId: z.number().int(),
  userRivalMusicDetailList: z.array(MusicDetailSchema),
  length: z.number().int().optional(),
});

export const UserMapEntrySchema = z.object({
  mapId: z.number().int(),
  distance: z.number().int().nonnegative(),
  isLock: z.boolean().optional(),
  isClear: z.boolean().optional(),
  isComplete: z.boolean().optional(),
  unlockFlag: z.number().int().optional(),
});

// ───────────────────────── job-type union ─────────────────────────

export const SdgbJobTypeSchema = z.enum([
  "scan_qr",
  "get_rival_hash",
  "get_user_map",
  "add_rival",
]);

export const SdgbJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);

// Per-job payloads (sent by backend, consumed by sdgb-worker).
export const ScanQrPayloadSchema = z.object({
  qrCode: z.string().min(1),
  callerUid: z.number().int().positive().optional(),
});
export const GetRivalHashPayloadSchema = z.object({
  cabinetUserId: z.number().int().positive(),
  callerUid: z.number().int().positive().optional(),
});
export const GetUserMapPayloadSchema = z.object({
  cabinetUserId: z.number().int().positive(),
});
export const AddRivalPayloadSchema = z.object({
  botCabinetUserId: z.number().int().positive(),
  targetCabinetUserId: z.number().int().positive(),
});

// Per-job results (set by sdgb-worker via PATCH).
export const ScanQrResultSchema = z.object({
  cabinetUserId: z.number().int().positive(),
  /**
   * Optional for backward compatibility with sdgb-worker instances that
   * predate the QR-login feature; new workers always populate it.
   */
  rivalName: z.string().optional(),
  music: z.array(MusicEntrySchema),
  hash: z.string(),
});
export const GetRivalHashResultSchema = z.object({
  hash: z.string(),
  music: z.array(MusicEntrySchema),
});
export const GetUserMapResultSchema = z.object({
  maps: z.array(UserMapEntrySchema),
});
export const AddRivalResultSchema = z.object({
  returnCode1: z.number().int(),
  returnCode2: z.number().int(),
});

// ───────────────────────── job document shape ─────────────────────────

export const SdgbJobResponseSchema = z.object({
  id: z.string(),
  jobType: SdgbJobTypeSchema,
  status: SdgbJobStatusSchema,
  payload: z.record(z.unknown()),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  requesterTag: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ───────────────────────── patch ─────────────────────────

export const SdgbJobPatchBodySchema = z.object({
  status: SdgbJobStatusSchema.optional(),
  result: z.record(z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
});

// ───────────────────────── inferred types ─────────────────────────

export type SdgbJobType = z.infer<typeof SdgbJobTypeSchema>;
export type SdgbJobStatus = z.infer<typeof SdgbJobStatusSchema>;
export type SdgbJobResponse = z.infer<typeof SdgbJobResponseSchema>;
export type SdgbJobPatchBody = z.infer<typeof SdgbJobPatchBodySchema>;
export type SdgbWorkerMusicEntry = z.infer<typeof MusicEntrySchema>;
export type SdgbWorkerMusicDetail = z.infer<typeof MusicDetailSchema>;
export type SdgbWorkerUserMapEntry = z.infer<typeof UserMapEntrySchema>;
export type ScanQrPayload = z.infer<typeof ScanQrPayloadSchema>;
export type GetRivalHashPayload = z.infer<typeof GetRivalHashPayloadSchema>;
export type GetUserMapPayload = z.infer<typeof GetUserMapPayloadSchema>;
export type AddRivalPayload = z.infer<typeof AddRivalPayloadSchema>;
export type ScanQrResult = z.infer<typeof ScanQrResultSchema>;
export type GetRivalHashResult = z.infer<typeof GetRivalHashResultSchema>;
export type GetUserMapResult = z.infer<typeof GetUserMapResultSchema>;
export type AddRivalResult = z.infer<typeof AddRivalResultSchema>;
