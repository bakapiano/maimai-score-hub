import {
  ManualScoreUpdateResponseSchema,
  OcrBatchRecognitionResponseSchema,
  type ManualScoreUpdateItem,
  type ManualScoreUpdateResponse,
  type OcrBatchRecognitionResponse,
} from "@maimai-score-hub/shared";

import { apiUrl } from "./baseUrl";

export class ScoreOcrApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ScoreOcrApiError";
    this.status = status;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScoreOcrApiError(response.status, "服务器返回了无法解析的响应");
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const body = payload as { message?: unknown; detail?: unknown };
  if (typeof body.message === "string") {
    return body.message;
  }
  if (typeof body.detail === "string") {
    return body.detail;
  }
  return fallback;
}

export async function recognizeScoreImages(input: {
  token: string;
  files: readonly File[];
  signal?: AbortSignal;
}): Promise<OcrBatchRecognitionResponse> {
  const form = new FormData();
  input.files.forEach((file) => form.append("images", file, file.name));
  const response = await fetch(apiUrl("/me/ocr/recognize"), {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}` },
    body: form,
    signal: input.signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new ScoreOcrApiError(
      response.status,
      errorMessage(payload, `成绩图识别失败 (HTTP ${response.status})`),
    );
  }
  const parsed = OcrBatchRecognitionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ScoreOcrApiError(response.status, "成绩图识别结果格式错误");
  }
  return parsed.data;
}
export async function submitRecognizedScores(input: {
  token: string;
  scores: readonly ManualScoreUpdateItem[];
}): Promise<ManualScoreUpdateResponse> {
  const response = await fetch(apiUrl("/me/sync/scores"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scores: input.scores }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new ScoreOcrApiError(
      response.status,
      errorMessage(payload, `成绩更新失败 (HTTP ${response.status})`),
    );
  }
  const parsed = ManualScoreUpdateResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ScoreOcrApiError(response.status, "成绩更新结果格式错误");
  }
  return parsed.data;
}
