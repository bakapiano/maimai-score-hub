import {
  getSdgbWorkerLaneForJobType,
  type SdgbWorkerClass,
  type SdgbWorkerLane,
  type SdgbWorkerRole,
} from '@maimai-score-hub/shared';

import {
  type SdgbFailureClass,
  type SdgbJobEntity,
  type SdgbJobStage,
  type SdgbJobStatus,
  type SdgbJobType,
  type SdgbSessionCleanupStatus,
  type SdgbWorkerLane as StoredSdgbWorkerLane,
} from '../schemas/sdgb-job.schema';
import type { StoredSdgbWorkerHeartbeat } from './sdgb-worker-registry.service';

export interface SdgbJobView {
  id: string;
  jobType: SdgbJobType;
  lane: StoredSdgbWorkerLane;
  routingVersion: number;
  status: SdgbJobStatus;
  stage: SdgbJobStage | null;
  cleanupStatus: SdgbSessionCleanupStatus;
  cleanupErrorCode: string | null;
  cleanupUpdatedAt: string | null;
  cleanupBlockedUntil: string | null;
  progress: { detailsFetched: number } | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  errorCode: string | null;
  executionToken: string | null;
  executionWorkerId: string | null;
  executionMembershipEpoch: number | null;
  executionNetworkEpoch: number | null;
  attempt: number;
  maxAttempts: number;
  retryAt: string | null;
  retryReason: string | null;
  failureClass: SdgbFailureClass | null;
  lastWorkerId: string | null;
  outcomeUnknown: boolean;
  requesterTag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SdgbAdminJobView extends SdgbJobView {
  ageSeconds: number;
  durationMs: number | null;
}

export interface SdgbAdminStatusView {
  workers: Array<{
    workerId: string;
    workerClass: SdgbWorkerClass;
    role: SdgbWorkerRole;
    lanes: readonly SdgbWorkerLane[];
    jobTypes: readonly SdgbJobType[];
    laneMemberships: StoredSdgbWorkerHeartbeat['laneMemberships'];
    lastSeenAt: string;
    ageSeconds: number;
    jobsClaimed: number;
    alive: boolean;
  }>;
  queue: Record<SdgbJobStatus, number>;
  byType: Array<{
    jobType: SdgbJobType;
    queued: number;
    processing: number;
    completedLastHour: number;
    failedLastHour: number;
  }>;
  oldestQueuedAgeSeconds: number | null;
  oldestProcessingAgeSeconds: number | null;
  recentJobs: SdgbAdminJobView[];
}

export interface SdgbJobListOptions {
  jobType?: SdgbJobType;
  status?: SdgbJobStatus;
  tag?: string;
  page: number;
  pageSize: number;
}

export interface SdgbJobListView {
  items: SdgbAdminJobView[];
  total: number;
  page: number;
  pageSize: number;
}

export function toSdgbJobView(
  doc: SdgbJobEntity,
  redactSensitive = false,
): SdgbJobView {
  return {
    id: doc.id,
    jobType: doc.jobType,
    lane: doc.lane ?? getSdgbWorkerLaneForJobType(doc.jobType),
    routingVersion: doc.routingVersion ?? 1,
    status: doc.status,
    stage: doc.stage ?? null,
    ...cleanupView(doc),
    progress: doc.progress ?? null,
    payload: payloadView(doc, redactSensitive),
    result: doc.result ?? null,
    error: doc.error ?? null,
    errorCode: doc.errorCode ?? null,
    ...executionView(doc),
    ...retryView(doc),
    requesterTag: doc.requesterTag ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toSdgbAdminView(
  doc: SdgbJobEntity,
  nowMs: number,
): SdgbAdminJobView {
  return {
    ...toSdgbJobView(doc, true),
    ageSeconds: secondsSince(doc.updatedAt, nowMs) ?? 0,
    durationMs: durationMs(doc, nowMs),
  };
}

export function secondsSince(
  date: Date | null | undefined,
  nowMs: number,
): number | null {
  return date ? Math.max(0, Math.floor((nowMs - date.getTime()) / 1000)) : null;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sdgbTimelineEventName(status: SdgbJobStatus): string {
  if (status === 'processing') {
    return 'picked';
  }
  return status === 'completed' || status === 'failed'
    ? status
    : 'status_changed';
}

export function roleForCapabilities(
  capabilities: readonly SdgbWorkerLane[],
): SdgbWorkerRole {
  return capabilities.includes('probe') && capabilities.includes('interactive')
    ? 'all'
    : (capabilities[0] ?? 'all');
}

function payloadView(
  doc: SdgbJobEntity,
  redactSensitive: boolean,
): Record<string, unknown> {
  const payload = { ...(doc.payload ?? {}) };
  if (redactSensitive && doc.jobType === 'get_music_score') {
    if ('qrCode' in payload) {
      payload.qrCode = '[REDACTED]';
    }
    if ('expectedCabinetUserId' in payload) {
      payload.expectedCabinetUserId = '[REDACTED]';
    }
  }
  return payload;
}

function cleanupView(doc: SdgbJobEntity) {
  return {
    cleanupStatus: doc.cleanupStatus ?? ('not_required' as const),
    cleanupErrorCode: doc.cleanupErrorCode ?? null,
    cleanupUpdatedAt: doc.cleanupUpdatedAt?.toISOString() ?? null,
    cleanupBlockedUntil: doc.cleanupBlockedUntil?.toISOString() ?? null,
  };
}

function executionView(doc: SdgbJobEntity) {
  return {
    executionToken: doc.executionToken ?? null,
    executionWorkerId: doc.executionWorkerId ?? null,
    executionMembershipEpoch: doc.executionMembershipEpoch ?? null,
    executionNetworkEpoch: doc.executionNetworkEpoch ?? null,
  };
}

function retryView(doc: SdgbJobEntity) {
  return {
    attempt: doc.attempt ?? 0,
    maxAttempts: doc.maxAttempts ?? 3,
    retryAt: doc.retryAt?.toISOString() ?? null,
    retryReason: doc.retryReason ?? null,
    failureClass: doc.failureClass ?? null,
    lastWorkerId: doc.lastWorkerId ?? null,
    outcomeUnknown: doc.outcomeUnknown ?? false,
  };
}

function durationMs(doc: SdgbJobEntity, nowMs: number): number | null {
  if (doc.status === 'processing') {
    return Math.max(0, nowMs - (doc.claimedAt ?? doc.updatedAt).getTime());
  }
  return doc.status === 'completed' || doc.status === 'failed'
    ? Math.max(0, doc.updatedAt.getTime() - doc.createdAt.getTime())
    : null;
}
