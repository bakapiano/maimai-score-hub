import type { CabinetScoreJob } from "@maimai-score-hub/shared";

import { apiUrl } from "./baseUrl";

export class CabinetScoreJobApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: string;

  constructor(
    status: number,
    code?: string,
    retryAfter?: string,
    message = "二维码成绩任务请求失败",
  ) {
    super(message);
    this.name = "CabinetScoreJobApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function request<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(apiUrl(path), { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new CabinetScoreJobApiError(
      response.status,
      typeof body.code === "string" ? body.code : undefined,
      typeof body.retryAfter === "string" ? body.retryAfter : undefined,
      typeof body.message === "string"
        ? body.message
        : `Unexpected status: ${response.status}`,
    );
  }
  return body as T;
}

export async function createCabinetScoreJob(
  payload: string | FormData,
  token: string,
) {
  const isText = typeof payload === "string";
  return request<{ jobId: string; job: CabinetScoreJob }>(
    "/me/cabinet-score-jobs",
    token,
    {
      method: "POST",
      headers: isText ? { "Content-Type": "application/json" } : undefined,
      body: isText ? JSON.stringify({ qrCode: payload }) : payload,
    },
  );
}

export function getCabinetScoreJob(
  jobId: string,
  token: string,
  signal?: AbortSignal,
) {
  return request<CabinetScoreJob>(
    `/me/cabinet-score-jobs/${encodeURIComponent(jobId)}`,
    token,
    { signal },
  );
}

export function getActiveCabinetScoreJob(token: string) {
  return request<{ job: CabinetScoreJob | null }>(
    "/me/cabinet-score-jobs/active",
    token,
  );
}
