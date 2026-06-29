/**
 * Job API 调用日志客户端
 * 用于收集和批量上报 bot 的 API 调用日志到后端
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

interface ApiLogEntry {
  url: string;
  method: string;
  statusCode: number;
  durationMs: number;
  responseBody: string | null;
}

interface ApiLogMetadata {
  workerId?: string;
  botFriendCode?: string | null;
}

interface ApiCallPayload {
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
export function recordApiLog(
  jobId: string,
  entry: ApiLogEntry,
  metadata: ApiLogMetadata = {},
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
    bodySize:
      typeof entry.responseBody === "string" ? entry.responseBody.length : null,
    errorClass: getErrorClass(entry),
    workerKind: "dxnet",
    workerId: metadata.workerId || getWorkerId(),
    botFriendCode: metadata.botFriendCode || "",
  });
}

/**
 * 将缓冲区中的日志批量上报到后端
 */
export async function flushApiLogs(jobId: string): Promise<void> {
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
        `[ApiLogClient] Failed to flush ${logs.length} logs for job ${jobId}. Status: ${response.status}`,
      );
    }
  } catch (err) {
    console.warn(`[ApiLogClient] Error flushing logs for job ${jobId}:`, err);
  }
}

/**
 * 清理某个 job 的日志缓冲区
 */
export function clearApiLogBuffer(jobId: string): void {
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

function getErrorClass(entry: ApiLogEntry): string | undefined {
  if (entry.statusCode === 567) {
    return "rate_limit_567";
  }
  if (entry.responseBody?.startsWith("[Error]")) {
    return "maimai_request_error";
  }
  if (entry.statusCode >= 400) {
    return "http_error";
  }
  return undefined;
}
