export interface AdminStats {
  userCount: number;
  musicCount: number;
  syncCount: number;
  coverCount: number;
}

export interface JobStatsTimeRange {
  label: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
}

export interface JobStatsWithDuration extends JobStatsTimeRange {
  avgDuration: number | null;
  minDuration: number | null;
  maxDuration: number | null;
}

export interface JobStats {
  nonScoreUpdate: JobStatsTimeRange[];
  scoreUpdate: JobStatsWithDuration[];
}

export type JobStatsRangeKey = 'oneHour' | 'oneDay' | 'sevenDays';

export const JOB_STATS_CACHE_TTL_MS = 60 * 1000;
export const JOB_STATS_MAX_TIME_MS = 3000;
export const JOB_STATS_RANGES: Array<{
  key: JobStatsRangeKey;
  label: string;
  ms: number;
}> = [
  { key: 'oneHour', label: '1小时', ms: 60 * 60 * 1000 },
  { key: 'oneDay', label: '24小时', ms: 24 * 60 * 60 * 1000 },
  { key: 'sevenDays', label: '7天', ms: 7 * 24 * 60 * 60 * 1000 },
];

export type JobStatsAggregateRow = Record<string, number | null>;

export interface JobTrendPoint {
  hour: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  avgDuration: number | null;
}

export interface JobTrend {
  nonScoreUpdate: JobTrendPoint[];
  scoreUpdate: JobTrendPoint[];
}

export interface JobErrorStatsItem {
  error: string;
  count: number;
}

export interface JobErrorStats {
  label: string;
  items: JobErrorStatsItem[];
}

export interface ActiveJob {
  id: string;
  friendCode: string;
  jobType: string;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  createdAt: string;
  updatedAt: string;
  runningDuration: number;
}

export interface ActiveJobsStats {
  queuedCount: number;
  processingCount: number;
  jobs: ActiveJob[];
}

export interface SearchJobResult {
  id: string;
  friendCode: string;
  jobType: string;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  error: string | null;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  updateScoreDuration: number | null;
  createdAt: string;
  updatedAt: string;
  raw: Record<string, unknown>;
}
