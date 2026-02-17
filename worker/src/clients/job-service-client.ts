/**
 * Job Service 客户端
 * 与后端 Job Service 通信的 API 客户端
 */

import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";
import type { Job, JobPatch, JobResponse } from "../types/index.ts";

import config from "../config.ts";

// Re-export types for backward compatibility
export type { Job, JobPatch, JobResponse };
export type { JobStatus, JobStage, UserProfile } from "../types/index.ts";

const { jobContract } = sharedContract;

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

const client = initClient(jobContract, {
  baseUrl: `${ensureBaseUrl()}/api`,
});

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
  const response = await client.next({
    body: { botUserFriendCode: botUserFriendCode ?? "" },
  });

  if (response.status === 204) {
    return null;
  }

  if (response.status !== 200) {
    throw new Error(`Failed to claim next job. Status: ${response.status}`);
  }

  return deserializeJob(response.body as JobResponse);
}

/**
 * 更新任务状态
 */
export async function updateJob(
  jobId: string,
  patch: JobPatch,
  signal?: AbortSignal,
): Promise<Job> {
  const response = await client.patch({
    params: { jobId },
    body: serializePatch(patch) as any,
    fetchOptions: { signal },
  });

  if (response.status !== 200) {
    throw new Error(`Failed to update job ${jobId}. Status: ${response.status}`);
  }

  return deserializeJob(response.body as JobResponse);
}

/**
 * 获取任务详情
 */
export async function getJob(jobId: string): Promise<Job> {
  const response = await client.getById({ params: { jobId } });
  if (response.status !== 200) {
    throw new Error(`Failed to fetch job ${jobId}. Status: ${response.status}`);
  }

  return deserializeJob(response.body as JobResponse);
}

/**
 * 获取 bot 当前处理中的活跃 friendCode 列表
 */
export async function getActiveFriendCodes(
  botUserFriendCode: string,
): Promise<string[]> {
  const response = await client.getActiveByBot({
    params: { botUserFriendCode },
  });
  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch active friend codes. Status: ${response.status}`,
    );
  }

  return response.body;
}

/**
 * 通知后端标记用户已 ready for 闲时更新
 */
export async function markIdleUpdateReady(
  friendCode: string,
  botFriendCode: string,
): Promise<void> {
  const response = await client.markIdleUpdateReady({
    body: { friendCode, botFriendCode },
  });

  if (response.status !== 200) {
    throw new Error(
      `Failed to mark idle update ready. Status: ${response.status}`,
    );
  }
}

/**
 * 获取指定 bot 的闲时更新 friendCode 列表
 */
export async function getIdleUpdateFriendCodes(
  botFriendCode: string,
): Promise<string[]> {
  const response = await client.getIdleUpdateFriends({
    params: { botFriendCode },
  });

  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch idle update friend codes. Status: ${response.status}`,
    );
  }

  return response.body;
}

/**
 * 检查当前 bot 是否是用户的闲时更新 bot
 */
export async function checkIsIdleUpdateBot(
  friendCode: string,
  botFriendCode: string,
): Promise<boolean> {
  const friendCodes = await getIdleUpdateFriendCodes(botFriendCode);
  return friendCodes.includes(friendCode);
}
