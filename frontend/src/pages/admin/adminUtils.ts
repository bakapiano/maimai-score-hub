import { useCallback, useState } from "react";

import { useOutletContext } from "react-router-dom";

// ── Interfaces ──

export interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
  friendCount: number | null;
  remark: string | null;
}

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
  skipUpdateScore: JobStatsTimeRange[];
  withUpdateScore: JobStatsWithDuration[];
}

export interface JobTrendPoint {
  hour: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  avgDuration: number | null;
}

export interface JobTrend {
  skipUpdateScore: JobTrendPoint[];
  withUpdateScore: JobTrendPoint[];
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
  skipUpdateScore: boolean;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  executing: boolean;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  createdAt: string;
  updatedAt: string;
  pickedAt: string | null;
  runningDuration: number;
}

export interface ActiveJobsStats {
  queuedCount: number;
  processingCount: number;
  jobs: ActiveJob[];
}

export interface AdminUser {
  id: string;
  friendCode: string;
  username: string | null;
  rating: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchJobResult {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  error: string | null;
  executing: boolean;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  updateScoreDuration: number | null;
  createdAt: string;
  updatedAt: string;
  pickedAt: string | null;
  raw: Record<string, unknown>;
}

export interface ApiLogEntry {
  url: string;
  method: string;
  statusCode: number;
  responseBody: string | null;
  createdAt: string;
}

// ── Constants ──

export const ADMIN_PASSWORD_KEY = "admin_password";

// ── Hooks ──

export function useAdminPassword() {
  const [password, setPassword] = useState<string>(() => {
    try {
      return localStorage.getItem(ADMIN_PASSWORD_KEY) || "";
    } catch {
      return "";
    }
  });

  const savePassword = useCallback((pwd: string) => {
    setPassword(pwd);
    try {
      if (pwd) {
        localStorage.setItem(ADMIN_PASSWORD_KEY, pwd);
      } else {
        localStorage.removeItem(ADMIN_PASSWORD_KEY);
      }
    } catch {
      // ignore
    }
  }, []);

  return { password, savePassword };
}

// ── Admin context hook ──

export interface AdminOutletContext {
  password: string;
}

export function useAdminContext() {
  return useOutletContext<AdminOutletContext>();
}
