import { useCallback, useState } from "react";
import { useOutletContext } from "react-router-dom";

export interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
  friendCount: number | null;
  remark: string | null;
  cabinetUserId: number | null;
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

export type AdminEnvironment = "prod" | "dev";
export type RealtimeWindow = "15m" | "1h" | "6h" | "24h";
export type HistoryWindow = "24h" | "7d" | "30d";
export type LogWindow = "5" | "15" | "60" | "360" | "1440";
export type JobErrorCategory = "user_error" | "remote_error" | "system_error";

export const API_SHARED_SECRET_KEY = "api_shared_secret";

export const ERROR_CATEGORY_META: Record<
  JobErrorCategory,
  { label: string; color: string }
> = {
  user_error: { label: "用户原因", color: "default" },
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

export function useApiSharedSecret() {
  const [password, setPassword] = useState<string>(() => {
    try {
      return localStorage.getItem(API_SHARED_SECRET_KEY) || "";
    } catch {
      return "";
    }
  });

  const savePassword = useCallback((pwd: string) => {
    setPassword(pwd);
    try {
      if (pwd) {
        localStorage.setItem(API_SHARED_SECRET_KEY, pwd);
      } else {
        localStorage.removeItem(API_SHARED_SECRET_KEY);
      }
    } catch {
      // Ignore storage failures in private mode.
    }
  }, []);

  return { password, savePassword };
}

export interface AdminOutletContext {
  password: string;
  environment: AdminEnvironment;
  realtimeWindow: RealtimeWindow;
  historyWindow: HistoryWindow;
  logWindow: LogWindow;
}

export function useAdminContext() {
  return useOutletContext<AdminOutletContext>();
}

export function getDefaultAdminEnvironment(): AdminEnvironment {
  if (typeof window === "undefined") {
    return "prod";
  }
  const host = window.location.hostname;
  return host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".devtunnels.ms")
    ? "dev"
    : "prod";
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) {
    return "-";
  }
  return formatSeconds(Math.max(0, Math.floor((value ?? 0) / 1000)));
}

export function formatSeconds(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) {
    return "-";
  }
  const seconds = Math.max(0, Math.floor(value ?? 0));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
