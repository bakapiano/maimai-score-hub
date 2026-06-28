/**
 * 统一类型定义模块
 * 集中管理所有共享类型，避免重复定义
 */

import type { JobPatchBody } from "@maimai-score-hub/shared";

// ============================================================================
// Game Types
// ============================================================================

export const GameType = {
  maimai: "maimai-dx",
  chunithm: "chunithm",
} as const;

export type GameType = (typeof GameType)[keyof typeof GameType];

export type ChartType = "standard" | "dx" | "utage";

// ============================================================================
// User Profile Types
// ============================================================================

export interface UserProfile {
  avatarUrl: string | null;
  title: string | null;
  titleColor: string | null;
  username: string | null;
  rating: number | null;
  ratingBgUrl: string | null;
  courseRankUrl: string | null;
  classRankUrl: string | null;
  awakeningCount: number | null;
}

// ============================================================================
// Job Types
// ============================================================================

export type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "canceled";

export type JobStage =
  | "send_request"
  | "wait_acceptance"
  | "wait_user_request"
  | "accept_request"
  | "update_score"
  | "get_user_recent_event"
  | "get_full_friend_list";
export type JobType =
  | "send_friend_request"
  | "accept_friend_request"
  | "update_score"
  | "get_user_recent_event"
  | "get_full_friend_list";

export interface ScoreProgress {
  completedDiffs: number[];
  totalDiffs: number;
}

export interface Job {
  id: string;
  friendCode: string;
  jobType?: JobType;
  priority?: number;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  friendRequestWaitStartedAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: AggregatedScoreResult;
  profile?: UserProfile;
  error?: string | null;
  scoreProgress?: ScoreProgress | null;
  updateScoreDuration?: number | null;
  diffsToScrape?: number[] | null;
  context?: Record<string, unknown> | null;
  removeFriendAfterComplete?: boolean;
  runAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobResponse = Omit<Job, "createdAt" | "updatedAt" | "runAt"> & {
  createdAt: string;
  updatedAt: string;
  runAt?: string | null;
};

export type JobPatch = Omit<JobPatchBody, "runAt" | "updatedAt"> & {
  runAt?: Date | string | null;
  updatedAt?: Date | string;
};

// ============================================================================
// Friend Request Types
// ============================================================================

export interface SentFriendRequest {
  friendCode: string;
  appliedAt: string | null;
}

export interface AcceptFriendRequest {
  friendCode: string;
  appliedAt: string | null;
}

export interface FriendInfo {
  friendCode: string;
  isFavorite: boolean;
  userName?: string | null;
  rating?: number | null;
  avatarUrl?: string | null;
  title?: string | null;
  titleColor?: string | null;
  ratingBgUrl?: string | null;
  courseRankUrl?: string | null;
  classRankUrl?: string | null;
  awakeningCount?: number | null;
}

export type FriendRecentEventDifficulty =
  | "basic"
  | "advanced"
  | "expert"
  | "master"
  | "remaster"
  | "utage";

export type FriendRecentEventFc = "fc" | "fcp" | "ap" | "app";
export type FriendRecentEventFs = "fs" | "fsp" | "fdx" | "fdxp";

export interface FriendRecentEvent {
  time: string;
  songName: string;
  fc: FriendRecentEventFc | null;
  fs: FriendRecentEventFs | null;
  difficulty: FriendRecentEventDifficulty | null;
  difficultyImageUrl: string | null;
}

// ============================================================================
// Score Types
// ============================================================================

export interface FriendVsSong {
  level: string;
  name: string;
  score: string | null;
  category: string | null;
  type: ChartType;
  fs: string | null;
  fc: string | null;
}

export interface ScoreEntry {
  level: string;
  dxScore?: string | null;
  score?: string | null;
  fs?: string | null;
  fc?: string | null;
}

export type AggregatedScoreResult = Record<
  string,
  Partial<Record<ChartType, Record<string, Record<number, ScoreEntry>>>>
>;

export interface ParsedScoreResult {
  diff: number;
  type: 1 | 2;
  songs: FriendVsSong[];
}
