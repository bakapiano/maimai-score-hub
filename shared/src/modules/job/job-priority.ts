import type { JobType } from './job.schema';

export const JOB_PRIORITY = {
  recentEvent: 1,
  updateScore: 2,
  userAuthRequest: 3,
} as const;

export function getJobTypePriority(jobType?: JobType | null): number {
  switch (jobType) {
    case 'send_friend_request':
    case 'accept_friend_request':
    case 'get_full_friend_list':
      return JOB_PRIORITY.userAuthRequest;
    case 'update_score':
      return JOB_PRIORITY.updateScore;
    case 'get_user_recent_event':
      return JOB_PRIORITY.recentEvent;
    default:
      return 0;
  }
}
