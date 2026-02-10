/**
 * 统一类型定义模块
 * 集中管理所有共享类型，避免重复定义
 */

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

export type JobStage = "send_request" | "wait_acceptance" | "update_score";
export type JobType = "immediate" | "idle_add_friend" | "idle_update_score";

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

export interface Job {
  id: string;
  friendCode: string;
  jobType?: JobType;
  skipUpdateScore?: boolean;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: AggregatedScoreResult;
  profile?: UserProfile;
  error?: string | null;
  executing?: boolean;
  scoreProgress?: ScoreProgress | null;
  updateScoreDuration?: number | null;
  pickedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobResponse = Omit<Job, "createdAt" | "updatedAt" | "pickedAt"> & {
  pickedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface JobPatch {
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  status?: JobStatus;
  stage?: JobStage;
  result?: AggregatedScoreResult;
  profile?: UserProfile;
  error?: string | null;
  executing?: boolean;
  scoreProgress?: ScoreProgress | null;
  /** 更新分数所耗时间（毫秒） */
  updateScoreDuration?: number | null;
  /** 原子操作：向 completedDiffs 添加一个难度（使用 MongoDB $addToSet） */
  addCompletedDiff?: number;
  updatedAt?: Date;
}

// ============================================================================
// Friend Request Types
// ============================================================================

export interface SentFriendRequest {
  friendCode: string;
  appliedAt: string | null;
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

/**
 * 聚合成绩结果
 * 结构: { [category]: { [chartType]: { [songName]: { [difficulty]: ScoreEntry } } } }
 */
export type AggregatedScoreResult = Record<
  string,
  Partial<Record<ChartType, Record<string, Record<number, ScoreEntry>>>>
>;

export interface ParsedScoreResult {
  diff: number;
  type: 1 | 2; // 1 = dxScore, 2 = score
  songs: FriendVsSong[];
}

// ============================================================================
// Cookie Types
// ============================================================================

export interface MaimaiCookieValues {
  _t?: string;
  userId?: string;
  friendCodeList?: string;
}

// ============================================================================
// HTTP Request Types
// ============================================================================

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  addToken?: boolean;
}
