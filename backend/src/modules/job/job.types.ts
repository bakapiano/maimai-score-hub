export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';
export type JobStage =
  | 'send_request'
  | 'wait_acceptance'
  | 'wait_user_request'
  | 'accept_request'
  | 'update_score'
  | 'get_full_friend_list';
export type JobType =
  | 'send_friend_request'
  | 'accept_friend_request'
  | 'update_score'
  | 'get_full_friend_list';

/**
 * 成绩更新进度
 * 记录每个难度的获取状态
 */
export interface ScoreProgress {
  /** 已完成的难度列表 */
  completedDiffs: number[];
  /** 总难度数量 */
  totalDiffs: number;
}

import type { UserNetProfile } from '../users/user.types';

export type UserProfile = UserNetProfile;

/**
 * Job patch request body
 */
export interface JobPatchBody {
  botUserFriendCode?: string | null;
  status?: JobStatus;
  stage?: JobStage;
  result?: unknown;
  profile?: UserProfile;
  error?: string | null;
  errorCode?:
    | 'cabinet_bot_unavailable'
    | 'cabinet_friendship_failed'
    | 'cabinet_friendship_unconfirmed'
    | 'job_deadline_exceeded'
    | null;
  friendRequestSentAt?: string | null;
  friendRequestWaitStartedAt?: string | null;
  runAt?: string | null;
  updatedAt?: string;
  scoreProgress?: ScoreProgress | null;
  addCompletedDiff?: number;
  updateScoreDuration?: number | null;
  execution: {
    deliveryEpoch: number;
    attemptsStarted: number;
    queueName: string;
    workerId: string;
  };
}

export interface JobResponse {
  id: string;
  friendCode: string;
  jobType: JobType;
  priority?: number;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  friendRequestWaitStartedAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  // result?: any;
  profile?: UserProfile;
  error?: string | null;
  scoreProgress?: ScoreProgress | null;
  updateScoreDuration?: number | null;
  diffsToScrape?: number[] | null;
  musicIds?: string[] | null;
  scoreFetchTargets?: ScoreFetchTarget[] | null;
  fcfsOnly?: boolean;
  context?: Record<string, unknown> | null;
  runAt?: string | null;
  deadlineAt?: string | null;
  cabinetFriendshipStatus?:
    | 'not_required'
    | 'pending'
    | 'running'
    | 'ready'
    | 'uncertain'
    | 'failed';
  errorCode?:
    | 'cabinet_bot_unavailable'
    | 'cabinet_friendship_failed'
    | 'cabinet_friendship_unconfirmed'
    | 'job_deadline_exceeded'
    | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerJobResponse extends Omit<JobResponse, 'friendCode'> {
  friendCode: string | null;
  result?: unknown;
  routing?: DxnetJobRouting | null;
  execution?: {
    deliveryEpoch: number;
    attemptsStarted: number;
    workerId: string;
    startedAt: string;
  } | null;
}
import type {
  DxnetJobRouting,
  ScoreFetchTarget,
} from '@maimai-score-hub/shared';
