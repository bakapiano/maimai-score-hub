/**
 * Job Service 客户端
 * 与后端 Job Service 通信的 API 客户端
 */

import * as sharedContract from "@maimai-score-hub/shared";

import type { Job, JobExecutionIdentity, JobPatch } from "../types.ts";

import type { JobPatchBody, WorkerJobResponse } from "@maimai-score-hub/shared";
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

function deserializeJob(payload: WorkerJobResponse): Job {
  return {
    ...payload,
    createdAt: new Date(payload.createdAt),
    updatedAt: new Date(payload.updatedAt),
    runAt: payload.runAt ? new Date(payload.runAt) : null,
    deadlineAt: payload.deadlineAt ? new Date(payload.deadlineAt) : null,
  } as unknown as Job;
}

function serializePatch(patch: JobPatch): Omit<JobPatchBody, "execution"> {
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
 * 获取 BullMQ 分发的任务详情。
 */
export async function getJob(jobId: string): Promise<Job> {
  const response = await client.getWorkerJob({
    params: { jobId },
  });

  if (response.status !== 200) {
    throw new Error(`Failed to fetch job ${jobId}. Status: ${response.status}`);
  }

  return deserializeJob(response.body as unknown as WorkerJobResponse);
}

/**
 * 更新任务状态
 */
export async function updateJob(
  jobId: string,
  patch: JobPatch,
  signal: AbortSignal | undefined,
  execution: JobExecutionIdentity,
): Promise<Job> {
  const response = await client.patch({
    params: { jobId },
    body: {
      ...serializePatch(patch),
      execution,
    },
    fetchOptions: { signal },
  });

  if (response.status !== 200) throw DxnetWorkerApiError.fromResponse(response);

  return deserializeJob(response.body as unknown as WorkerJobResponse);
}

export async function prepareCabinetFriendship(
  jobId: string,
  execution: JobExecutionIdentity,
  signal?: AbortSignal,
): Promise<{ status: Job["cabinetFriendshipStatus"] }> {
  const response = await client.prepareCabinetFriendship({
    params: { jobId },
    body: {
      execution: {
        deliveryEpoch: execution.deliveryEpoch,
        attemptsStarted: execution.attemptsStarted,
        workerId: execution.workerId,
      },
    },
    fetchOptions: { signal },
  });
  if (response.status !== 200) throw DxnetWorkerApiError.fromResponse(response);
  return response.body;
}

export class DxnetWorkerApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;

  constructor(status: number, code: string, reason?: string, message?: string) {
    super(message ?? `${code} (${status})`);
    this.name = "DxnetWorkerApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }

  static fromResponse(response: {
    status: number;
    body?: unknown;
  }): DxnetWorkerApiError {
    const body =
      response.body && typeof response.body === "object"
        ? (response.body as Record<string, unknown>)
        : {};
    const nested =
      body.message && typeof body.message === "object"
        ? (body.message as Record<string, unknown>)
        : body;
    return new DxnetWorkerApiError(
      response.status,
      typeof nested.code === "string" ? nested.code : "worker_api_error",
      typeof nested.reason === "string" ? nested.reason : undefined,
      typeof nested.message === "string" ? nested.message : undefined,
    );
  }
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
 * 获取正在 QR 登录慢路径中的玩家名。此时可能还没有 friendCode，
 * 清理好友时需要按 name 暂时保留。
 */
export async function getRunningQrLoginRivalNames(): Promise<string[]> {
  const response = await client.getRunningQrLoginRivalNames();
  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch running QR-login rival names. Status: ${response.status}`,
    );
  }

  return response.body;
}

/**
 * 批量查询用户活跃度
 */
export async function getUsersActivity(friendCodes: string[]): Promise<
  {
    friendCode: string;
    lastActiveAt: string | null;
    cabinetUserId: number | null;
  }[]
> {
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
