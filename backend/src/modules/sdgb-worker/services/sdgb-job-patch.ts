import { BadRequestException } from '@nestjs/common';
import type { SdgbJobPatchBody } from '@maimai-score-hub/shared';

import type { SdgbJobEntity } from '../schemas/sdgb-job.schema';

export interface WorkerExecutionGuard {
  executionToken: string;
  executionWorkerId: string;
  executionMembershipEpoch: number;
  executionNetworkEpoch: number;
}

export function requireExecution(body: SdgbJobPatchBody): WorkerExecutionGuard {
  if (
    !body.executionToken ||
    !body.executionWorkerId ||
    body.executionMembershipEpoch === undefined ||
    body.executionNetworkEpoch === undefined
  ) {
    throw new BadRequestException(
      'worker patch requires execution token, worker, membership and network epochs',
    );
  }
  return {
    executionToken: body.executionToken,
    executionWorkerId: body.executionWorkerId,
    executionMembershipEpoch: body.executionMembershipEpoch,
    executionNetworkEpoch: body.executionNetworkEpoch,
  };
}

export function buildSdgbMongoPatch(
  existing: SdgbJobEntity,
  body: SdgbJobPatchBody,
  execution: WorkerExecutionGuard | undefined,
  now: Date,
): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: now };
  applyStatusAndStage(update, body);
  applyCleanup(update, existing, body, now);
  applyResult(update, body);
  applyExecutionTransition(update, existing, body, execution, now);
  const mongoUpdate: Record<string, unknown> = { $set: update };
  if (existing.jobType === 'get_music_score' && body.status === 'failed') {
    mongoUpdate.$unset = { 'payload.qrCode': 1 };
  }
  return mongoUpdate;
}

function applyStatusAndStage(
  update: Record<string, unknown>,
  body: SdgbJobPatchBody,
): void {
  if (body.status !== undefined) {
    update.status = body.status;
  }
  if (body.stage !== undefined) {
    update.stage = body.stage;
  }
}

function applyCleanup(
  update: Record<string, unknown>,
  existing: SdgbJobEntity,
  body: SdgbJobPatchBody,
  now: Date,
): void {
  if (body.cleanupStatus !== undefined) {
    if (
      existing.cleanupStatus === 'succeeded' &&
      body.cleanupStatus !== 'succeeded'
    ) {
      throw new BadRequestException('cleanupStatus cannot leave succeeded');
    }
    update.cleanupStatus = body.cleanupStatus;
    update.cleanupUpdatedAt = now;
  }
  if (body.cleanupErrorCode !== undefined) {
    update.cleanupErrorCode = body.cleanupErrorCode;
  }
  if (body.cleanupBlockedUntil !== undefined) {
    update.cleanupBlockedUntil = body.cleanupBlockedUntil
      ? new Date(body.cleanupBlockedUntil)
      : null;
  }
}

function applyResult(
  update: Record<string, unknown>,
  body: SdgbJobPatchBody,
): void {
  if (body.progress !== undefined) {
    update.progress = body.progress;
  }
  if (body.result !== undefined) {
    update.result = body.result;
  }
  if (body.error !== undefined) {
    update.error = body.error;
  }
  if (body.errorCode !== undefined) {
    update.errorCode = body.errorCode;
  }
  if (body.outcomeUnknown !== undefined) {
    update.outcomeUnknown = body.outcomeUnknown;
  }
}

function applyExecutionTransition(
  update: Record<string, unknown>,
  existing: SdgbJobEntity,
  body: SdgbJobPatchBody,
  execution: WorkerExecutionGuard | undefined,
  now: Date,
): void {
  if (body.status === 'processing') {
    update.executing = true;
    update.claimedAt = now;
    if (execution) {
      update.executionToken = execution.executionToken;
      update.executionWorkerId = execution.executionWorkerId;
      update.executionMembershipEpoch = execution.executionMembershipEpoch;
      update.executionNetworkEpoch = execution.executionNetworkEpoch;
      update.lastWorkerId = execution.executionWorkerId;
    }
  }
  if (body.status === 'completed' || body.status === 'failed') {
    update.executing = false;
    update.lastWorkerId =
      existing.executionWorkerId ?? execution?.executionWorkerId ?? null;
    update.executionToken = null;
    update.executionWorkerId = null;
    update.executionMembershipEpoch = null;
    update.executionNetworkEpoch = null;
  }
}
