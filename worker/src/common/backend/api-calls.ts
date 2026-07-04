/**
 * External API call metadata client.
 * Buffers DXNet call metadata and reports it to backend/ClickHouse.
 */

import { initClient } from "@ts-rest/core";
import * as sharedContract from "@maimai-score-hub/shared";

import { getJobServiceBaseUrl } from "./jobs.ts";
import { backendTsRestApi } from "./http.ts";

const { observabilityContract } = sharedContract;

const client = initClient(observabilityContract as any, {
  baseUrl: `${getJobServiceBaseUrl()}/api/v1`,
  api: backendTsRestApi,
}) as any;

interface ExternalApiCallEntry {
  url: string;
  method: string;
  statusCode: number;
  durationMs: number;
  bodySize: number | null;
  errorClass?: string;
}

interface ExternalApiCallMetadata {
  workerId?: string;
  botFriendCode?: string | null;
}

export interface ApiCallPayload {
  ts: string;
  target: string;
  apiGroup: string;
  method: string;
  urlGroup: string;
  statusCode: number;
  durationMs: number;
  bodySize: number | null;
  errorClass?: string;
  workerKind: "dxnet";
  workerId: string;
  botFriendCode: string;
}

/** 每个 job 维护一个待上报的日志缓冲区 */
const logBuffers = new Map<string, ApiCallPayload[]>();

/**
 * 记录一条 API 调用日志
 */
export function recordExternalApiCall(
  jobId: string,
  entry: ExternalApiCallEntry,
  metadata: ExternalApiCallMetadata = {},
): void {
  let buffer = logBuffers.get(jobId);
  if (!buffer) {
    buffer = [];
    logBuffers.set(jobId, buffer);
  }

  const group = classifyDxnetUrl(entry.url);
  buffer.push({
    ts: new Date().toISOString(),
    target: "maimai_dxnet",
    apiGroup: group.apiGroup,
    method: entry.method,
    urlGroup: group.urlGroup,
    statusCode: entry.statusCode,
    durationMs: Math.max(0, Math.floor(entry.durationMs)),
    bodySize: entry.bodySize,
    errorClass: entry.errorClass || undefined,
    workerKind: "dxnet",
    workerId: metadata.workerId || getWorkerId(),
    botFriendCode: metadata.botFriendCode || "",
  });
}

/**
 * 将缓冲区中的日志批量上报到后端
 */
export async function flushExternalApiCalls(jobId: string): Promise<void> {
  const buffer = logBuffers.get(jobId);
  if (!buffer || buffer.length === 0) return;

  // 取出并清空缓冲区
  const logs = buffer.splice(0);

  try {
    const response = await client.ingestExternalApiCalls({
      params: { jobId },
      body: { calls: logs },
    });

    if (response.status !== 201) {
      console.warn(
        `[ExternalApiCallClient] Failed to flush ${logs.length} calls for job ${jobId}. Status: ${response.status}`,
      );
    }
  } catch (err) {
    console.warn(
      `[ExternalApiCallClient] Error flushing calls for job ${jobId}:`,
      err,
    );
  }
}

export async function reportWorkerExternalApiCalls(
  kind: string,
  calls: ApiCallPayload[],
): Promise<void> {
  if (calls.length === 0) return;
  try {
    const response = await client.ingestWorkerExternalApiCalls({
      params: { kind },
      body: { calls },
    });
    if (response.status !== 201) {
      console.warn(
        `[ExternalApiCallClient] Failed to report ${calls.length} ${kind} calls. Status: ${response.status}`,
      );
    }
  } catch (err) {
    console.warn(`[ExternalApiCallClient] Error reporting ${kind} calls:`, err);
  }
}

/**
 * 清理某个 job 的日志缓冲区
 */
export function clearExternalApiCallBuffer(jobId: string): void {
  logBuffers.delete(jobId);
}

function getWorkerId(): string {
  return (
    process.env.WORKER_ID || `dxnet-worker-${process.env.HOSTNAME || "unknown"}`
  );
}

function classifyDxnetUrl(url: string): { apiGroup: string; urlGroup: string } {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Keep the original string for substring matching below.
  }
  if (pathname.includes("friendGenreVs")) {
    return { apiGroup: "maimai.friend", urlGroup: "maimai.friend.genre_vs" };
  }
  if (pathname.includes("friendDetail")) {
    return { apiGroup: "maimai.friend", urlGroup: "maimai.friend.detail" };
  }
  if (pathname.includes("friendInvite")) {
    return { apiGroup: "maimai.friend", urlGroup: "maimai.friend.invite" };
  }
  if (pathname.includes("friendSearch")) {
    return { apiGroup: "maimai.friend", urlGroup: "maimai.friend.search" };
  }
  if (pathname.includes("friend")) {
    return { apiGroup: "maimai.friend", urlGroup: "maimai.friend.pages" };
  }
  return { apiGroup: "maimai.dxnet", urlGroup: "maimai.dxnet.unknown" };
}
