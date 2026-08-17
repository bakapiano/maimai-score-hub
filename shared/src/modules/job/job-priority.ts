import type { JobType } from "./job.schema";

export const DXNET_PRIORITY = {
  maintenance: 0,
  background: 1,
  userSync: 2,
  interactive: 3,
  immediate: 4,
} as const;

export const JOB_PRIORITY = {
  recentEvent: DXNET_PRIORITY.background,
  updateScore: DXNET_PRIORITY.userSync,
  userAuthRequest: DXNET_PRIORITY.interactive,
} as const;

export const DXNET_PRIORITY_MIN = DXNET_PRIORITY.maintenance;
export const DXNET_PRIORITY_MAX = DXNET_PRIORITY.immediate;

export function assertDxnetPriority(priority: number): void {
  if (
    !Number.isSafeInteger(priority) ||
    priority < DXNET_PRIORITY_MIN ||
    priority > DXNET_PRIORITY_MAX
  ) {
    throw new Error("DXNet priority must be an integer from 0 to 4");
  }
}

/** BullMQ uses lower positive values first; zero/undefined would jump the queue. */
export function toDxnetBullmqPriority(priority: number): number {
  assertDxnetPriority(priority);
  return 5 - priority;
}

export function getJobTypePriority(jobType?: JobType | null): number {
  switch (jobType) {
    case "send_friend_request":
    case "accept_friend_request":
    case "get_full_friend_list":
      return JOB_PRIORITY.userAuthRequest;
    case "update_score":
      return JOB_PRIORITY.updateScore;
    case "get_user_recent_event":
      return JOB_PRIORITY.recentEvent;
    default:
      return 0;
  }
}
