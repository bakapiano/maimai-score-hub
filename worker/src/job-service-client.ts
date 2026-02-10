/**
 * Job Service 客户端
 * 与后端 Job Service 通信的 API 客户端
 */

import type { Job, JobPatch, JobResponse } from "./types/index.ts";

import config from "./config.ts";

// Re-export types for backward compatibility
export type { Job, JobPatch, JobResponse };
export type { JobStatus, JobStage, UserProfile } from "./types/index.ts";

const baseUrl = (config.jobService?.baseUrl ?? "").replace(/\/$/, "");

function ensureBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("Job service baseUrl is not configured");
  }
  return baseUrl;
}

export function buildUrl(path: string): string {
  return `${ensureBaseUrl()}${path}`;
}

function deserializeJob(payload: JobResponse): Job {
  return {
    ...payload,
    pickedAt: payload.pickedAt ? new Date(payload.pickedAt) : null,
    createdAt: new Date(payload.createdAt),
    updatedAt: new Date(payload.updatedAt),
  };
}

function serializePatch(patch: JobPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (patch.botUserFriendCode !== undefined) {
    body.botUserFriendCode = patch.botUserFriendCode;
  }
  if (patch.friendRequestSentAt !== undefined) {
    body.friendRequestSentAt = patch.friendRequestSentAt;
  }
  if (patch.status !== undefined) {
    body.status = patch.status;
  }
  if (patch.stage !== undefined) {
    body.stage = patch.stage;
  }
  if (patch.result !== undefined) {
    body.result = patch.result;
  }
  if (patch.profile !== undefined) {
    body.profile = patch.profile;
  }
  if (patch.error !== undefined) {
    body.error = patch.error;
  }
  if (patch.executing !== undefined) {
    body.executing = patch.executing;
  }
  if (patch.scoreProgress !== undefined) {
    body.scoreProgress = patch.scoreProgress;
  }
  if (patch.updateScoreDuration !== undefined) {
    body.updateScoreDuration = patch.updateScoreDuration;
  }
  if (patch.addCompletedDiff !== undefined) {
    body.addCompletedDiff = patch.addCompletedDiff;
  }
  body.updatedAt = (patch.updatedAt ?? new Date()).toISOString();

  return body;
}

/**
 * 获取 Job Service 基础 URL
 */
export function getJobServiceBaseUrl(): string {
  return baseUrl;
}

/**
 * 领取下一个待处理的任务
 */
export async function claimNextJob(
  botUserFriendCode?: string,
): Promise<Job | null> {
  const response = await fetch(buildUrl("/api/job/next"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botUserFriendCode }),
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to claim next job. Status: ${response.status}. Body: ${text}`,
    );
  }

  const payload = (await response.json()) as JobResponse;
  return deserializeJob(payload);
}

/**
 * 更新任务状态
 */
export async function updateJob(
  jobId: string,
  patch: JobPatch,
  signal?: AbortSignal,
): Promise<Job> {
  const response = await fetch(buildUrl(`/api/job/${jobId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serializePatch(patch)),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to update job ${jobId}. Status: ${response.status}. Body: ${text}`,
    );
  }

  const payload = (await response.json()) as JobResponse;
  return deserializeJob(payload);
}

/**
 * 获取任务详情
 */
export async function getJob(jobId: string): Promise<Job> {
  const response = await fetch(buildUrl(`/api/job/${jobId}`));
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch job ${jobId}. Status: ${response.status}. Body: ${text}`,
    );
  }

  const payload = (await response.json()) as JobResponse;
  return deserializeJob(payload);
}

/**
 * 获取 bot 当前处理中的活跃 friendCode 列表
 */
export async function getActiveFriendCodes(
  botUserFriendCode: string,
): Promise<string[]> {
  const response = await fetch(
    buildUrl(`/api/job/active/${encodeURIComponent(botUserFriendCode)}`),
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch active friend codes. Status: ${response.status}. Body: ${text}`,
    );
  }

  return (await response.json()) as string[];
}

/**
 * 通知后端标记用户已 ready for 闲时更新
 */
export async function markIdleUpdateReady(
  friendCode: string,
  botFriendCode: string,
): Promise<void> {
  const response = await fetch(buildUrl("/api/job/idle-update/mark-ready"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ friendCode, botFriendCode }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to mark idle update ready. Status: ${response.status}. Body: ${text}`,
    );
  }
}

/**
 * 获取指定 bot 的闲时更新 friendCode 列表
 */
export async function getIdleUpdateFriendCodes(
  botFriendCode: string,
): Promise<string[]> {
  const response = await fetch(
    buildUrl(
      `/api/job/idle-update/friends/${encodeURIComponent(botFriendCode)}`,
    ),
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch idle update friend codes. Status: ${response.status}. Body: ${text}`,
    );
  }

  return (await response.json()) as string[];
}
