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
  | 'get_user_recent_event'
  | 'get_full_friend_list';
export type JobType =
  | 'send_friend_request'
  | 'accept_friend_request'
  | 'update_score'
  | 'get_user_recent_event'
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
  friendRequestSentAt?: string | null;
  friendRequestWaitStartedAt?: string | null;
  executing?: boolean;
  runAt?: string | null;
  updatedAt?: string;
  scoreProgress?: ScoreProgress | null;
  addCompletedDiff?: number;
  updateScoreDuration?: number | null;
}

export interface JobResponse {
  id: string;
  friendCode: string;
  jobType: JobType;
  priority?: number;
  skipUpdateScore: boolean;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  friendRequestWaitStartedAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  // result?: any;
  profile?: UserProfile;
  error?: string | null;
  executing?: boolean;
  scoreProgress?: ScoreProgress | null;
  updateScoreDuration?: number | null;
  autoExportResult?: {
    divingFish?: { status: string; message?: string } | null;
    lxns?: { status: string; message?: string } | null;
  } | null;
  isAuthenticated?: boolean;
  cabinetScoreMap?: Record<string, { achievement: number; dxScore: number }> | null;
  diffsToScrape?: number[] | null;
  runAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
