import type { Document } from "mongodb";

export type SdgbLane = "probe" | "interactive";
export type SdgbJobType =
  | "scan_qr"
  | "get_rival_hash"
  | "get_user_map"
  | "add_rival"
  | "get_music_score";

export interface SdgbJobRecord extends Document {
  id: string;
  jobType: SdgbJobType;
  lane: SdgbLane;
  routingVersion: number;
  status: "queued" | "processing" | "completed" | "failed";
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  errorCode: string | null;
  cleanupStatus: string;
  claimedAt: Date | null;
  executionToken: string | null;
  executionWorkerId: string | null;
  executionMembershipEpoch: number | null;
  executionNetworkEpoch: number | null;
  attempt: number;
  maxAttempts: number;
  requesterTag: string;
  ownerUserId: string | null;
  ownerFriendCode: string | null;
  lastWorkerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

export function makeJob(input: {
  id: string;
  jobType: SdgbJobType;
  requesterTag: string;
  payload?: Record<string, unknown>;
  lane?: SdgbLane;
  maxAttempts?: number;
}): SdgbJobRecord {
  const now = new Date();
  return {
    id: input.id,
    jobType: input.jobType,
    lane: input.lane ?? laneFor(input.jobType),
    routingVersion: 1,
    status: "queued",
    stage: null,
    cleanupStatus: "not_required",
    cleanupErrorCode: null,
    cleanupUpdatedAt: null,
    cleanupBlockedUntil: null,
    progress: null,
    payload: input.payload ?? defaultPayload(input.jobType),
    result: null,
    error: null,
    errorCode: null,
    executing: false,
    claimedAt: null,
    executionToken: null,
    executionWorkerId: null,
    executionMembershipEpoch: null,
    executionNetworkEpoch: null,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    retryAt: null,
    retryReason: null,
    failureClass: null,
    lastWorkerId: null,
    outcomeUnknown: false,
    requesterTag: input.requesterTag,
    ownerUserId: null,
    ownerFriendCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function laneFor(jobType: SdgbJobType): SdgbLane {
  return jobType === "get_user_map" || jobType === "get_rival_hash"
    ? "probe"
    : "interactive";
}

function defaultPayload(jobType: SdgbJobType): Record<string, unknown> {
  switch (jobType) {
    case "get_user_map":
    case "get_rival_hash":
      return { cabinetUserId: 10_000_001 };
    case "scan_qr":
      return { qrCode: "e2e-fake-qr" };
    case "add_rival":
      return {
        botCabinetUserId: 10_000_001,
        targetCabinetUserId: 10_000_002,
      };
    case "get_music_score":
      return { qrCode: "e2e-fake-qr" };
  }
}
