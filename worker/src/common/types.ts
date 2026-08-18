/**
 * 统一类型定义模块
 * 集中管理所有共享类型，避免重复定义
 */

import type {
  CabinetFriendshipStatus,
  DxnetExecution,
  DxnetExecutionRequest,
  DxnetJobErrorCode,
  DxnetJobRouting,
  JobPatchBody,
  ScoreFetchTarget,
} from "@maimai-score-hub/shared";

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
  "queued" | "processing" | "completed" | "failed" | "canceled";

export type JobStage =
  | "send_request"
  | "wait_acceptance"
  | "wait_user_request"
  | "accept_request"
  | "update_score"
  | "get_full_friend_list";
export type JobType =
  | "send_friend_request"
  | "accept_friend_request"
  | "update_score"
  | "get_full_friend_list";

export interface ScoreProgress {
  completedDiffs: number[];
  totalDiffs: number;
}

export interface Job {
  id: string;
  friendCode: string | null;
  jobType?: JobType;
  priority?: number;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  friendRequestWaitStartedAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: UpdateScoreResult;
  profile?: UserProfile;
  error?: string | null;
  scoreProgress?: ScoreProgress | null;
  updateScoreDuration?: number | null;
  diffsToScrape?: number[] | null;
  musicIds?: string[] | null;
  scoreFetchTargets?: ScoreFetchTarget[] | null;
  fcfsOnly?: boolean;
  context?: Record<string, unknown> | null;
  runAt?: Date | null;
  deadlineAt?: Date | null;
  cabinetFriendshipStatus?: CabinetFriendshipStatus;
  errorCode?: DxnetJobErrorCode | null;
  routing?: DxnetJobRouting | null;
  execution?: DxnetExecution | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobResponse = Omit<Job, "createdAt" | "updatedAt" | "runAt"> & {
  createdAt: string;
  updatedAt: string;
  runAt?: string | null;
};

export type JobPatch = Omit<
  JobPatchBody,
  "runAt" | "updatedAt" | "execution"
> & {
  runAt?: Date | string | null;
  updatedAt?: Date | string;
};

export type JobExecutionIdentity = DxnetExecutionRequest;

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
  diff?: number;
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

export interface TargetedScoreEntry {
  /** Chart-specific catalog id (`charts[].cid`). */
  musicId: string;
  dxScore?: string | null;
  score?: string | null;
  fs?: string | null;
  fc?: string | null;
}

export interface TargetedScoreResult {
  targetedScores: TargetedScoreEntry[];
}

export type UpdateScoreResult = AggregatedScoreResult | TargetedScoreResult;

export interface ParsedScoreResult {
  diff: number;
  type: 1 | 2;
  songs: FriendVsSong[];
}
