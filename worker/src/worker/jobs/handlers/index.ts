import type {
  Job,
  JobPatch,
  JobStage,
  JobType,
} from "../../../common/types.ts";

import type { MaimaiClient } from "../../../common/maimai/client.ts";
import { acceptFriendRequestJobHandler } from "./accept-friend-request/index.ts";
import { getFullFriendListJobHandler } from "./get-full-friend-list/index.ts";
import { getUserRecentEventJobHandler } from "./get-user-recent-event/index.ts";
import { sendFriendRequestJobHandler } from "./send-friend-request/index.ts";
import { updateScoreJobHandler } from "./update-score/index.ts";

export interface JobExecutionContext {
  job: Job;
  client: MaimaiClient;
  applyPatch(patch: JobPatch): Promise<Job>;
  transitionTo(stage: JobStage, patch?: JobPatch): Promise<Job>;
  delay(ms: number, patch?: JobPatch): Promise<Job>;
  fail(error: string, patch?: JobPatch): Promise<Job>;
  completeJob(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface JobTypeHandler {
  prepare?(ctx: JobExecutionContext): Promise<void>;
  execute(ctx: JobExecutionContext): Promise<void>;
}

export async function prepareJob(ctx: JobExecutionContext): Promise<void> {
  await getJobTypeHandler(ctx).prepare?.(ctx);
}

export async function executeJobByType(
  ctx: JobExecutionContext,
): Promise<void> {
  await getJobTypeHandler(ctx).execute(ctx);
}

export function getJobTypeHandler(ctx: JobExecutionContext): JobTypeHandler {
  return getJobTypeHandlerByType(ctx.job.jobType);
}

function getJobTypeHandlerByType(jobType?: JobType | null): JobTypeHandler {
  switch (jobType) {
    case "send_friend_request":
      return sendFriendRequestJobHandler;
    case "accept_friend_request":
      return acceptFriendRequestJobHandler;
    case "update_score":
      return updateScoreJobHandler;
    case "get_user_recent_event":
      return getUserRecentEventJobHandler;
    case "get_full_friend_list":
      return getFullFriendListJobHandler;
    default:
      throw new Error(`Unknown jobType: ${String(jobType)}`);
  }
}
