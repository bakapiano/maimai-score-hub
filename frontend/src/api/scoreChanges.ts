import {
  ScoreChangeHistoryResponseSchema,
  type ScoreChangeHistoryResponse,
  ScoreHistoryFeedResponseSchema,
  type ScoreHistoryFeedResponse,
  ScoreHistoryCalendarResponseSchema,
  type ScoreHistoryCalendarResponse,
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

type ScoreHistoryFeedRequest = {
  token: string;
  start: number;
  end: number;
  signal?: AbortSignal;
};

export async function fetchScoreHistoryFeed(
  input: ScoreHistoryFeedRequest,
): Promise<ScoreHistoryFeedResponse> {
  const params = new URLSearchParams({
    start: String(input.start),
    end: String(input.end),
  });
  const response = await fetch(apiUrl(`/me/score-history?${params}`), {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`获取成绩历史失败 (HTTP ${response.status})`);
  }
  const parsed = ScoreHistoryFeedResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error("成绩历史响应格式无效");
  }
  return parsed.data;
}

type ScoreHistoryCalendarRequest = {
  token: string;
  from: number;
  to: number;
  timeZone: string;
  dayStartHour: number;
  signal?: AbortSignal;
};

export async function fetchScoreHistoryCalendar(
  input: ScoreHistoryCalendarRequest,
): Promise<ScoreHistoryCalendarResponse> {
  const params = new URLSearchParams({
    from: String(input.from),
    to: String(input.to),
    timeZone: input.timeZone,
    dayStartHour: String(input.dayStartHour),
  });
  const response = await fetch(apiUrl(`/me/score-history/calendar?${params}`), {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`获取成绩历史日历失败 (HTTP ${response.status})`);
  }
  const parsed = ScoreHistoryCalendarResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error("成绩历史日历响应格式无效");
  }
  return parsed.data;
}
