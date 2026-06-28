import { getJobTypePriority } from '@maimai-score-hub/shared';

import type { JobResponse } from '../job.types';
import type { JobEntity } from '../schemas/job.schema';

export function toJobResponse(job: JobEntity): JobResponse {
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
    removeFriendAfterComplete: job.removeFriendAfterComplete ?? false,
    runAt: job.runAt?.toISOString() ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
