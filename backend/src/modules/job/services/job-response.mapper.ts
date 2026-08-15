import { getJobTypePriority } from '@maimai-score-hub/shared';

import type { JobResponse, WorkerJobResponse } from '../job.types';
import type { JobEntity } from '../schemas/job.schema';

export function toJobResponse(job: JobEntity): JobResponse {
  if (!job.friendCode) {
    throw new Error(`Internal DXNet job ${job.id} has no public friendCode`);
  }
  return {
    id: job.id,
    friendCode: job.friendCode,
    jobType: job.jobType ?? 'send_friend_request',
    priority: job.priority ?? getJobTypePriority(job.jobType),
    botUserFriendCode: job.botUserFriendCode ?? null,
    friendRequestSentAt: job.friendRequestSentAt ?? null,
    friendRequestWaitStartedAt: job.friendRequestWaitStartedAt ?? null,
    status: job.status,
    stage: job.stage,
    profile: job.profile,
    scoreProgress: job.scoreProgress ?? null,
    updateScoreDuration: job.updateScoreDuration ?? null,
    diffsToScrape: job.diffsToScrape ?? null,
    context: job.context ?? null,
    runAt: job.runAt?.toISOString() ?? null,
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    cabinetFriendshipStatus: job.cabinetFriendship?.status ?? 'not_required',
    errorCode: job.errorCode ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

// Nullish defaults are field serialization, not control-flow branches.
// eslint-disable-next-line complexity
export function toWorkerJobResponse(job: JobEntity): WorkerJobResponse {
  const base = {
    id: job.id,
    friendCode: job.friendCode ?? null,
    jobType: job.jobType ?? 'send_friend_request',
    priority: job.priority ?? getJobTypePriority(job.jobType),
    botUserFriendCode: job.botUserFriendCode ?? null,
    friendRequestSentAt: job.friendRequestSentAt ?? null,
    friendRequestWaitStartedAt: job.friendRequestWaitStartedAt ?? null,
    status: job.status,
    stage: job.stage,
    profile: job.profile,
    result: job.result,
    scoreProgress: job.scoreProgress ?? null,
    updateScoreDuration: job.updateScoreDuration ?? null,
    diffsToScrape: job.diffsToScrape ?? null,
    context: job.context ?? null,
    runAt: job.runAt?.toISOString() ?? null,
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    cabinetFriendshipStatus: job.cabinetFriendship?.status ?? 'not_required',
    errorCode: job.errorCode ?? null,
    error: job.error ?? null,
    routing: job.routing ?? null,
    execution: job.execution
      ? {
          ...job.execution,
          startedAt: job.execution.startedAt.toISOString(),
        }
      : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  } satisfies WorkerJobResponse;
  return base;
}
