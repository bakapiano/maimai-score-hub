export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled';
export type JobStage = 'send_request' | 'wait_acceptance' | 'update_score';

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

export interface JobResponse {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: any;
  profile?: UserProfile;
  error?: string | null;
  executing?: boolean;
  scoreProgress?: ScoreProgress | null;
  updateScoreDuration?: number | null;
  createdAt: string;
  updatedAt: string;
}
