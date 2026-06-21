/**
 * Job Service 客户端
 * 与后端 Job Service 通信的 API 客户端
 */

import * as sharedContract from "@maimai-score-hub/shared";

import type { Job, JobPatch, JobResponse } from "../types.ts";

import type { JobPatchBody } from "@maimai-score-hub/shared";
import { backendTsRestApi } from "./http.ts";
import config from "../config.ts";
import { initClient } from "@ts-rest/core";

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
  baseUrl: `${ensureBaseUrl()}/api/v1`,
  api: backendTsRestApi,
});

function deserializeJob(payload: JobResponse): Job {
  return {
    ...payload,
    createdAt: new Date(payload.createdAt),
    updatedAt: new Date(payload.updatedAt),
    runAt: payload.runAt ? new Date(payload.runAt) : null,
  };
}

function serializePatch(patch: JobPatch): JobPatchBody {
  const { runAt, updatedAt, ...body } = patch;

  return {
    ...body,
    ...(runAt !== undefined
      ? { runAt: runAt instanceof Date ? runAt.toISOString() : runAt }
      : {}),
    ...(updatedAt !== undefined
      ? {
          updatedAt:
            updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
        }
      : {}),
  };
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
  waitMs?: number,
): Promise<Job | null> {
  const response = await client.next({
    body: { botUserFriendCode: botUserFriendCode ?? "", waitMs },
  });

  if (response.status === 204) {
    return null;
  }

  if (response.status !== 200) {
    throw new Error(`Failed to claim next job. Status: ${response.status}`);
  }

  return deserializeJob(response.body as unknown as JobResponse);
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
    body: serializePatch(patch),
    fetchOptions: { signal },
  });

  if (response.status !== 200) {
    throw new Error(
      `Failed to update job ${jobId}. Status: ${response.status}`,
    );
  }

  return deserializeJob(response.body as unknown as JobResponse);
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
 * 批量查询用户活跃度
 */
export async function getUsersActivity(
  friendCodes: string[],
): Promise<{ friendCode: string; lastActiveAt: string | null }[]> {
  if (!friendCodes.length) return [];
  const response = await client.getUsersActivity({
    body: { friendCodes },
  });

  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch users activity. Status: ${response.status}`,
    );
  }

  return response.body;
}

/**
 * 批量查询这些 friendCode 中哪些存在对应的注册 user。
 * 返回存在的 friendCode 子集。
 */
export async function getExistingUsers(
  friendCodes: string[],
): Promise<string[]> {
  if (!friendCodes.length) return [];
  const response = await client.getExistingUsers({
    body: { friendCodes },
  });

  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch existing users. Status: ${response.status}`,
    );
  }

  return response.body.existingFriendCodes;
}
