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

export const SdgbWorkerLaneSchema = z.enum(["probe", "interactive"]);

export const SdgbJobTypeSchema = z.enum([
  "scan_qr",
  "get_rival_hash",
  "get_user_map",
  "add_rival",
  "get_music_score",
]);

export const SdgbJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);

export const SdgbJobStageSchema = z.enum([
  "queued",
  "qr_auth",
  "preview",
  "login",
  "get_music",
  "logout",
  "cleanup",
  "persist",
]);

export const SdgbSessionCleanupStatusSchema = z.enum([
  "not_required",
  "pending",
  "succeeded",
  "unconfirmed",
]);

export const SdgbJobProgressSchema = z.object({
  detailsFetched: z.number().int().nonnegative(),
});

export const SdgbFailureClassSchema = z.enum([
  "empty_response",
  "network_error",
  "timeout",
  "invalid_response",
  "outcome_unknown",
  "membership_lost",
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
export const GetMusicScorePayloadSchema = z.object({
  qrCode: z.string().min(1).max(512),
  expectedCabinetUserId: z.number().int().positive(),
});

export const UserMusicDetailSchema = z.object({
  musicId: z.number().int().nonnegative(),
  level: z.number().int(),
  playCount: z.number().int().nonnegative(),
  achievement: z.number().int().nonnegative(),
  comboStatus: z.number().int().min(0).max(4),
  syncStatus: z.number().int().min(0).max(5),
  deluxscoreMax: z.number().int().nonnegative(),
  scoreRank: z.number().int(),
  extNum1: z.number().int().optional(),
  extNum2: z.number().int().optional(),
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
export const GetMusicScoreResultSchema = z.object({
  cabinetUserId: z.number().int().positive(),
  musicDetails: z.array(UserMusicDetailSchema).max(10_000),
});

// ───────────────────────── job document shape ─────────────────────────

export const SdgbJobResponseSchema = z.object({
  id: z.string(),
  jobType: SdgbJobTypeSchema,
  lane: SdgbWorkerLaneSchema,
  routingVersion: z.number().int().positive(),
  status: SdgbJobStatusSchema,
  stage: SdgbJobStageSchema.nullable().optional(),
  cleanupStatus: SdgbSessionCleanupStatusSchema.optional(),
  cleanupErrorCode: z.string().nullable().optional(),
  cleanupUpdatedAt: z.string().nullable().optional(),
  cleanupBlockedUntil: z.string().nullable().optional(),
  progress: SdgbJobProgressSchema.nullable().optional(),
  payload: z.record(z.unknown()),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  executionToken: z.string().nullable(),
  executionWorkerId: z.string().nullable(),
  executionMembershipEpoch: z.number().int().positive().nullable(),
  executionNetworkEpoch: z.number().int().nonnegative().nullable(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  retryAt: z.string().nullable(),
  retryReason: z.string().nullable(),
  failureClass: SdgbFailureClassSchema.nullable(),
  lastWorkerId: z.string().nullable(),
  outcomeUnknown: z.boolean(),
  requesterTag: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ───────────────────────── patch ─────────────────────────

export const SdgbJobPatchBodySchema = z.object({
  executionToken: z.string().min(1).optional(),
  executionWorkerId: z.string().min(1).optional(),
  executionMembershipEpoch: z.number().int().positive().optional(),
  executionNetworkEpoch: z.number().int().nonnegative().optional(),
  status: SdgbJobStatusSchema.optional(),
  stage: SdgbJobStageSchema.optional(),
  cleanupStatus: SdgbSessionCleanupStatusSchema.optional(),
  cleanupErrorCode: z.string().nullable().optional(),
  cleanupBlockedUntil: z.string().nullable().optional(),
  progress: SdgbJobProgressSchema.nullable().optional(),
  result: z.record(z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  outcomeUnknown: z.boolean().optional(),
  requeue: z
    .object({
      failureClass: SdgbFailureClassSchema,
      retryReason: z.string().min(1).max(512),
      retryAt: z.string().datetime(),
    })
    .optional(),
});

// ───────────────────────── inferred types ─────────────────────────

export type SdgbJobType = z.infer<typeof SdgbJobTypeSchema>;
export type SdgbJobStatus = z.infer<typeof SdgbJobStatusSchema>;
export type SdgbJobStage = z.infer<typeof SdgbJobStageSchema>;
export type SdgbSessionCleanupStatus = z.infer<
  typeof SdgbSessionCleanupStatusSchema
>;
export type SdgbJobProgress = z.infer<typeof SdgbJobProgressSchema>;
export type SdgbFailureClass = z.infer<typeof SdgbFailureClassSchema>;
export type SdgbJobResponse = z.infer<typeof SdgbJobResponseSchema>;
export type SdgbJobPatchBody = z.infer<typeof SdgbJobPatchBodySchema>;
export type SdgbWorkerMusicEntry = z.infer<typeof MusicEntrySchema>;
export type SdgbWorkerMusicDetail = z.infer<typeof MusicDetailSchema>;
export type SdgbWorkerUserMapEntry = z.infer<typeof UserMapEntrySchema>;
export type ScanQrPayload = z.infer<typeof ScanQrPayloadSchema>;
export type GetRivalHashPayload = z.infer<typeof GetRivalHashPayloadSchema>;
export type GetUserMapPayload = z.infer<typeof GetUserMapPayloadSchema>;
export type AddRivalPayload = z.infer<typeof AddRivalPayloadSchema>;
export type GetMusicScorePayload = z.infer<typeof GetMusicScorePayloadSchema>;
export type ScanQrResult = z.infer<typeof ScanQrResultSchema>;
export type GetRivalHashResult = z.infer<typeof GetRivalHashResultSchema>;
export type GetUserMapResult = z.infer<typeof GetUserMapResultSchema>;
export type AddRivalResult = z.infer<typeof AddRivalResultSchema>;
export type GetMusicScoreResult = z.infer<typeof GetMusicScoreResultSchema>;
export type SdgbWorkerUserMusicDetail = z.infer<typeof UserMusicDetailSchema>;
