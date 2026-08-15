import type { ScoreChange, ScoreChangeField } from "@maimai-score-hub/shared";

export type ScoreHistorySettings = {
  dayStartHour: number;
  mergeSameChart: boolean;
  keyChangesOnly: boolean;
};

export type ScoreHistoryDisplayItem = {
  change: ScoreChange;
  mergedCount: number;
};

export const DEFAULT_SCORE_HISTORY_SETTINGS: ScoreHistorySettings = {
  dayStartHour: 6,
  mergeSameChart: true,
  keyChangesOnly: false,
};

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateParts(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

export function businessDayKey(value: string | number, dayStartHour: number) {
  const date = new Date(value);
  const boundary = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    dayStartHour,
  );
  if (date.getTime() < boundary.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return localDateKey(boundary);
}

export function businessDayRange(key: string, dayStartHour: number) {
  const { year, month, day } = dateParts(key);
  const from = new Date(year, month - 1, day, dayStartHour);
  const to = new Date(year, month - 1, day + 1, dayStartHour);
  return { from: from.getTime(), to: to.getTime() };
}

export function currentBusinessDayKey(dayStartHour: number) {
  return businessDayKey(Date.now(), dayStartHour);
}

export function initialCalendarRange(dayStartHour: number) {
  const current = currentBusinessDayKey(dayStartHour);
  const { from: currentFrom, to } = businessDayRange(current, dayStartHour);
  const fromDate = new Date(currentFrom);
  fromDate.setFullYear(fromDate.getFullYear() - 1);
  return { from: fromDate.getTime(), to };
}

export function initialHistoryWindow(dayStartHour: number) {
  const current = currentBusinessDayKey(dayStartHour);
  const { to: end } = businessDayRange(current, dayStartHour);
  return { start: shiftLocalMonths(end, -3), end };
}

export function previousHistoryWindow(start: number) {
  return { start: shiftLocalMonths(start, -3), end: start };
}

function shiftLocalMonths(value: number, amount: number) {
  const date = new Date(value);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  const lastDay = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
  ).getDate();
  date.setDate(Math.min(day, lastDay));
  return date.getTime();
}

export function previousCalendarYear(from: number) {
  const date = new Date(from);
  date.setFullYear(date.getFullYear() - 1);
  return date.getTime();
}

export function businessDayLabel(key: string) {
  const { year, month, day } = dateParts(key);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(year, month - 1, day, 12));
}

function scoreNumber(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberDelta(before: number | null, after: number | null) {
  return after === null ? null : after - (before ?? 0);
}

function mergedChange(newest: ScoreChange, oldest: ScoreChange, fields: Set<ScoreChangeField>) {
  return {
    ...newest,
    beforeScoreVersion: oldest.beforeScoreVersion,
    before: oldest.before,
    changedFields: [...fields],
    achievementDelta: numberDelta(
      scoreNumber(oldest.before.score),
      scoreNumber(newest.after.score),
    ),
    dxScoreDelta: numberDelta(
      scoreNumber(oldest.before.dxScore),
      scoreNumber(newest.after.dxScore),
    ),
    ratingDelta: numberDelta(
      oldest.before.rating ?? null,
      newest.after.rating ?? null,
    ),
    fcRankDelta: null,
    fsRankDelta: null,
  } satisfies ScoreChange;
}

export function historyDisplayItems(
  items: ScoreChange[],
  settings: ScoreHistorySettings,
): ScoreHistoryDisplayItem[] {
  if (!settings.mergeSameChart) {
    return items.map((change) => ({ change, mergedCount: 1 }));
  }
  const groups = new Map<
    string,
    {
      newest: ScoreChange;
      oldest: ScoreChange;
      fields: Set<ScoreChangeField>;
      count: number;
    }
  >();
  for (const change of items) {
    const key = `${businessDayKey(change.observedAt, settings.dayStartHour)}:${change.musicId}:${change.chartIndex}:${change.type}`;
    const existing = groups.get(key);
    if (existing) {
      existing.oldest = change;
      existing.count += 1;
      change.changedFields.forEach((field) => existing.fields.add(field));
    } else {
      groups.set(key, {
        newest: change,
        oldest: change,
        fields: new Set(change.changedFields),
        count: 1,
      });
    }
  }
  return [...groups.values()].map((group) => ({
    change: mergedChange(group.newest, group.oldest, group.fields),
    mergedCount: group.count,
  }));
}
