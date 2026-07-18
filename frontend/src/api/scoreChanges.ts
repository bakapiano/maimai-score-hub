import {
  ScoreChangeHistoryResponseSchema,
  type ScoreChangeHistoryResponse,
} from "@maimai-score-hub/shared";

import { apiUrl } from "./baseUrl";

type ScoreChangeHistoryRequest = {
  token: string;
  musicId: string;
  chartIndex: number;
  type: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
};

export async function fetchScoreChangeHistory(
  input: ScoreChangeHistoryRequest,
): Promise<ScoreChangeHistoryResponse> {
  const params = new URLSearchParams({
    musicId: input.musicId,
    chartIndex: String(input.chartIndex),
    type: input.type,
    limit: String(input.limit ?? 30),
  });
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await fetch(apiUrl(`/me/score-changes?${params}`), {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`获取成绩变化记录失败 (HTTP ${response.status})`);
  }

  const parsed = ScoreChangeHistoryResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error("成绩变化记录响应格式无效");
  }
  return parsed.data;
}
