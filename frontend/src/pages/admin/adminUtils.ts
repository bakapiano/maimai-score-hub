import { useCallback, useState } from "react";

import { useOutletContext } from "react-router-dom";

// ── Interfaces ──

export interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
  friendCount: number | null;
  remark: string | null;
  cabinetUserId: number | null;
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

export type JobErrorCategory = "user_error" | "remote_error" | "system_error";

export const ERROR_CATEGORY_META: Record<
  JobErrorCategory,
  { label: string; color: string }
> = {
  user_error: { label: "用户原因", color: "gray" },
  remote_error: { label: "远端问题", color: "orange" },
  system_error: { label: "系统问题", color: "red" },
};

export function categorizeJobError(
  error: string | null | undefined,
): JobErrorCategory {
  const message = (error ?? "").toLowerCase();
  if (
    message.includes("等待用户发送好友请求超时") ||
    message.includes("等待好友接受请求超时") ||
    message.includes("未找到该好友代码") ||
    message.includes("好友代码") ||
    message.includes("friendcode") ||
    message.includes("请先绑定二维码") ||
    message.includes("no-sync")
  ) {
    return "user_error";
  }

  if (
    message.includes("http 5") ||
    message.includes("请求超时") ||
    message.includes("限流") ||
    message.includes("567") ||
    message.includes("522") ||
    message.includes("wahlap") ||
    message.includes("fetch failed")
  ) {
    return "remote_error";
  }

  return "system_error";
}

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
