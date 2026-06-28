import type { JobStage, JobStatus, JobType } from '../job.types';

export const FRIENDSHIP_PROOF_MAX_AGE_MS = 10 * 60 * 1000;

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'canceled',
] as const;

export const VALID_STATUS: readonly JobStatus[] = [
  'queued',
  'processing',
  'completed',
  'canceled',
  'failed',
] as const;

export const VALID_STAGE: readonly JobStage[] = [
  'send_request',
  'wait_acceptance',
  'wait_user_request',
  'accept_request',
  'update_score',
  'get_user_recent_event',
  'get_full_friend_list',
] as const;

export const JOB_STAGE_MAP: Record<JobType, readonly JobStage[]> = {
  send_friend_request: ['send_request', 'wait_acceptance'],
  accept_friend_request: ['wait_user_request', 'accept_request'],
  update_score: ['update_score'],
  get_user_recent_event: ['get_user_recent_event'],
  get_full_friend_list: ['get_full_friend_list'],
};

export function initialStageForJobType(jobType: JobType): JobStage {
  if (jobType === 'update_score') {
    return 'update_score';
  }
  if (jobType === 'accept_friend_request') {
    return 'wait_user_request';
  }
  if (jobType === 'get_user_recent_event') {
    return 'get_user_recent_event';
  }
  if (jobType === 'get_full_friend_list') {
    return 'get_full_friend_list';
  }
  return 'send_request';
}
