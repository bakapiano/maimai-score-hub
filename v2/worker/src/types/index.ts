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

export interface Job {
  id: string;
  friendCode: string;
  skipUpdateScore?: boolean;
  botUserFriendCode?: string | null;
  friendRequestSentAt?: string | null;
  status: JobStatus;
  stage: JobStage;
  result?: AggregatedScoreResult;
  profile?: UserProfile;
  error?: string | null;
  executing?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type JobResponse = Omit<Job, "createdAt" | "updatedAt"> & {
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
