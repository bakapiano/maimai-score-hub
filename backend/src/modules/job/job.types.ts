export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';
export type JobStage =
  | 'send_request'
  | 'wait_acceptance'
  | 'update_score'
  | 'fetch_friend_list';
export type JobType =
  | 'immediate'
  | 'idle_add_friend'
  | 'idle_update_score'
  | 'fetch_friend_list';

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
  executing?: boolean;
  updatedAt?: string;
  scoreProgress?: ScoreProgress | null;
  addCompletedDiff?: number;
  updateScoreDuration?: number | null;
}

export interface JobResponse {
  id: string;
  friendCode: string;
  jobType: JobType;
  skipUpdateScore: boolean;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
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
  createdAt: string;
  updatedAt: string;
}
