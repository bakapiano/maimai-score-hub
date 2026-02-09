/**
 * Job API 调用日志客户端
 * 用于收集和批量上报 bot 的 API 调用日志到后端
 */

import { buildUrl } from "./job-service-client.ts";

export interface ApiLogEntry {
  url: string;
  method: string;
  statusCode: number;
  responseBody: string | null;
}

/** 每个 job 维护一个待上报的日志缓冲区 */
const logBuffers = new Map<string, ApiLogEntry[]>();

/** Response body 最大截断长度 (1 MB，确保 HTML 页面不被截断) */
const MAX_BODY_LENGTH = 1024 * 1024;

/**
 * 记录一条 API 调用日志
 */
export function recordApiLog(jobId: string, entry: ApiLogEntry): void {
  let buffer = logBuffers.get(jobId);
  if (!buffer) {
    buffer = [];
    logBuffers.set(jobId, buffer);
  }

  buffer.push({
    ...entry,
    responseBody: entry.responseBody
      ? entry.responseBody.slice(0, MAX_BODY_LENGTH)
      : null,
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
    const response = await fetch(buildUrl(`/api/job/${jobId}/api-logs`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logs }),
    });

    if (!response.ok) {
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
