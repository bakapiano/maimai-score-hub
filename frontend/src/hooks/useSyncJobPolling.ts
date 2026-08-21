import { useEffect, useEffectEvent, useRef } from "react";
import type { CabinetScoreJob, JobResponse } from "@maimai-score-hub/shared";

import {
  CabinetScoreJobApiError,
  getCabinetScoreJob,
} from "../api/cabinetScoreJobClient";
import { JobApiError, getJobById } from "../api/jobClient";

const FAILURE_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const DEADLINE_GRACE_MS = 60_000;
const DXNET_FALLBACK_TIMEOUT_MS = 21 * 60_000;
const CABINET_TIMEOUT_MS = 30 * 60_000;

type PollOptions<T> = {
  pollKey: string | null;
  enabled: boolean;
  intervalMs: number;
  stopAt: number | null;
  fallbackTimeoutMs: number;
  timeoutMessage: string;
  request: (signal: AbortSignal) => Promise<T>;
  handleValue: (value: T) => boolean | Promise<boolean>;
  terminalError: (error: unknown) => string | null;
  failureMessage: string;
  retryMessage: (failures: number) => string;
  onRetry: (message: string) => void;
  onStop: (message: string) => void;
};

function useBoundedStatusPoll<T>(options: PollOptions<T>) {
  const latestOptions = useEffectEvent(() => options);

  useEffect(() => {
    if (!options.enabled || !options.pollKey) {
      return;
    }

    let stopped = false;
    let requestInFlight = false;
    let consecutiveFailures = 0;
    let activeController: AbortController | null = null;
    const stopAt = options.stopAt ?? Date.now() + options.fallbackTimeoutMs;

    const pollStatus = async () => {
      if (stopped || requestInFlight) {
        return;
      }
      if (Date.now() >= stopAt) {
        stopped = true;
        latestOptions().onStop(options.timeoutMessage);
        return;
      }

      requestInFlight = true;
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(
        () => controller.abort(new Error("status request timed out")),
        REQUEST_TIMEOUT_MS,
      );
      try {
        const value = await latestOptions().request(controller.signal);
        if (stopped) {
          return;
        }
        consecutiveFailures = 0;
        const keepPolling = await latestOptions().handleValue(value);
        if (!keepPolling) {
          stopped = true;
        }
      } catch (error) {
        if (stopped) {
          return;
        }
        consecutiveFailures += 1;
        const terminalMessage = latestOptions().terminalError(error);
        if (terminalMessage || consecutiveFailures >= FAILURE_LIMIT) {
          stopped = true;
          latestOptions().onStop(
            terminalMessage ?? latestOptions().failureMessage,
          );
          return;
        }
        latestOptions().onRetry(
          latestOptions().retryMessage(consecutiveFailures),
        );
      } finally {
        window.clearTimeout(timeout);
        activeController = null;
        requestInFlight = false;
      }
    };

    void pollStatus();
    const interval = window.setInterval(
      () => void pollStatus(),
      options.intervalMs,
    );
    return () => {
      stopped = true;
      activeController?.abort();
      window.clearInterval(interval);
    };
  }, [
    options.enabled,
    options.fallbackTimeoutMs,
    options.intervalMs,
    options.pollKey,
    options.stopAt,
    options.timeoutMessage,
  ]);
}

type DxnetPollingOptions = {
  jobId: string | null;
  syncing: boolean;
  token: string | null;
  deadlineAt?: string | null;
  setStatus: (job: JobResponse) => void;
  setError: (message: string | null) => void;
  stop: () => void;
  startScoreJob: (friendshipJobId: string) => Promise<void>;
  completed: (job: JobResponse) => void;
  failed: (job: JobResponse) => void;
};

export function useDxnetJobPolling(options: DxnetPollingOptions) {
  const chainedFriendshipJobIdRef = useRef<string | null>(null);
  const declaredDeadline = options.deadlineAt
    ? new Date(options.deadlineAt).getTime()
    : Number.NaN;
  const stopAt = Number.isFinite(declaredDeadline)
    ? declaredDeadline + DEADLINE_GRACE_MS
    : null;

  useBoundedStatusPoll<JobResponse>({
    pollKey: options.jobId,
    enabled: !!options.jobId && options.syncing && !!options.token,
    intervalMs: 1_500,
    stopAt,
    fallbackTimeoutMs: DXNET_FALLBACK_TIMEOUT_MS,
    timeoutMessage: "任务状态查询已超过截止时间，请重新发起同步",
    request: (signal) =>
      getJobById(options.jobId ?? "", options.token ?? "", signal),
    handleValue: async (job) => {
      options.setError(null);
      options.setStatus(job);
      if (job.status === "completed" && job.jobType === "send_friend_request") {
        if (chainedFriendshipJobIdRef.current === job.id) {
          return false;
        }
        chainedFriendshipJobIdRef.current = job.id;
        try {
          await options.startScoreJob(job.id);
        } catch (error) {
          chainedFriendshipJobIdRef.current = null;
          options.stop();
          const message = error instanceof Error ? error.message : "未知错误";
          options.setError(`创建成绩更新任务失败: ${message}`);
        }
        return false;
      }
      if (job.status === "completed") {
        options.stop();
        options.completed(job);
        return false;
      }
      if (job.status === "failed" || job.status === "canceled") {
        options.stop();
        options.failed(job);
        return false;
      }
      return true;
    },
    terminalError: (error) => {
      if (
        !(error instanceof JobApiError) ||
        error.status < 400 ||
        error.status >= 500
      ) {
        return null;
      }
      return error.status === 404
        ? "同步任务不存在或已过期"
        : "同步任务状态查询被服务端拒绝，请重新登录后重试";
    },
    failureMessage: "多次查询同步状态失败，请检查网络后重试",
    retryMessage: (failures) =>
      `同步状态查询失败，正在重试（${failures}/${FAILURE_LIMIT}）`,
    onRetry: options.setError,
    onStop: (message) => {
      options.stop();
      options.setError(message);
    },
  });
}

type CabinetPollingOptions = {
  jobId: string | null;
  syncing: boolean;
  token: string | null;
  createdAt?: string | null;
  setStatus: (job: CabinetScoreJob) => void;
  setError: (message: string | null) => void;
  stop: () => void;
  completed: (job: CabinetScoreJob) => void;
  failed: (job: CabinetScoreJob) => void;
};

export function useCabinetJobPolling(options: CabinetPollingOptions) {
  const createdAt = options.createdAt
    ? new Date(options.createdAt).getTime()
    : Number.NaN;
  const stopAt = Number.isFinite(createdAt)
    ? createdAt + CABINET_TIMEOUT_MS
    : null;

  useBoundedStatusPoll<CabinetScoreJob>({
    pollKey: options.jobId,
    enabled: !!options.jobId && options.syncing && !!options.token,
    intervalMs: 1_000,
    stopAt,
    fallbackTimeoutMs: CABINET_TIMEOUT_MS,
    timeoutMessage: "二维码任务状态查询超时，请重新发起更新",
    request: (signal) =>
      getCabinetScoreJob(options.jobId ?? "", options.token ?? "", signal),
    handleValue: (job) => {
      options.setError(null);
      options.setStatus(job);
      const cleanupBlocked =
        job.cleanupStatus === "pending" ||
        (job.cleanupStatus === "unconfirmed" &&
          !!job.error?.retryAfter &&
          new Date(job.error.retryAfter).getTime() > Date.now());
      if (job.status === "completed") {
        options.stop();
        options.completed(job);
        return false;
      }
      if (job.status === "failed" && !cleanupBlocked) {
        options.stop();
        options.failed(job);
        return false;
      }
      return true;
    },
    terminalError: (error) => {
      if (
        !(error instanceof CabinetScoreJobApiError) ||
        error.status < 400 ||
        error.status >= 500
      ) {
        return null;
      }
      return error.status === 404
        ? "二维码任务不存在或已过期"
        : "二维码任务状态查询被服务端拒绝，请重新登录后重试";
    },
    failureMessage: "多次查询二维码任务状态失败，请检查网络后重试",
    retryMessage: (failures) =>
      `二维码任务状态查询失败，正在重试（${failures}/${FAILURE_LIMIT}）`,
    onRetry: options.setError,
    onStop: (message) => {
      options.stop();
      options.setError(message);
    },
  });
}
