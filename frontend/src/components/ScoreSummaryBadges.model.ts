import { useCallback, useState } from "react";

import type { SyncScore } from "../types/syncScore";

export const rankOrder = ["SSS+", "SSS", "SS+", "SS", "S+", "S"] as const;
export type RankBucket = (typeof rankOrder)[number];

export const fcOrder = ["ap+", "ap", "fc+", "fc"] as const;
export const fsOrder = ["fsd+", "fsd", "fs+", "fs"] as const;
export type FcBucket = (typeof fcOrder)[number];
export type FsBucket = (typeof fsOrder)[number];

export type BadgeFilterKind = "rank" | "fc" | "fs";
export type BadgeFilterMode = "include" | "exclude";
export type BadgeFilter = {
  kind: BadgeFilterKind;
  bucket: string;
  mode: BadgeFilterMode;
} | null;

export type RankSummary = {
  counts: Record<RankBucket, number>;
  total: number;
};

export type StatusSummary = {
  fc: Record<FcBucket, number>;
  fs: Record<FsBucket, number>;
  total: number;
};

type ScoreEntry = {
  score?: Pick<SyncScore, "score" | "dxScore" | "fc" | "fs">;
};

const RANK_THRESHOLD: Record<RankBucket, number> = {
  "SSS+": 100.5,
  SSS: 100,
  "SS+": 99.5,
  SS: 99,
  "S+": 98,
  S: 97,
};

const emptyCounts = (): Record<RankBucket, number> => ({
  "SSS+": 0,
  SSS: 0,
  "SS+": 0,
  SS: 0,
  "S+": 0,
  S: 0,
});

const emptyStatusCounts = (): {
  fc: Record<FcBucket, number>;
  fs: Record<FsBucket, number>;
} => ({
  fc: fcOrder.reduce<Record<FcBucket, number>>(
    (acc, key) => {
      acc[key] = 0;
      return acc;
    },
    {} as Record<FcBucket, number>,
  ),
  fs: fsOrder.reduce<Record<FsBucket, number>>(
    (acc, key) => {
      acc[key] = 0;
      return acc;
    },
    {} as Record<FsBucket, number>,
  ),
});

const scoreToRank = (scoreText?: string | null): RankBucket | null => {
  if (!scoreText) {
    return null;
  }
  const val = parseFloat(scoreText.replace("%", ""));
  if (!Number.isFinite(val)) {
    return null;
  }
  if (val >= 100.5) {
    return "SSS+";
  }
  if (val >= 100) {
    return "SSS";
  }
  if (val >= 99.5) {
    return "SS+";
  }
  if (val >= 99) {
    return "SS";
  }
  if (val >= 98) {
    return "S+";
  }
  if (val >= 97) {
    return "S";
  }
  return null;
};

const entryMatchesBadge = (
  entry: ScoreEntry,
  kind: BadgeFilterKind,
  bucket: string,
): boolean => {
  if (kind === "rank") {
    const threshold = RANK_THRESHOLD[bucket as RankBucket];
    if (threshold === undefined) {
      return false;
    }
    const text = entry.score?.score ?? entry.score?.dxScore ?? null;
    if (!text) {
      return false;
    }
    const val = parseFloat(text.replace("%", ""));
    return Number.isFinite(val) && val >= threshold;
  }
  if (kind === "fc") {
    return entry.score?.fc?.toLowerCase?.() === bucket;
  }
  return entry.score?.fs?.toLowerCase?.() === bucket;
};

export const cycleBadgeFilter = (
  current: BadgeFilter,
  kind: BadgeFilterKind,
  bucket: string,
): BadgeFilter => {
  if (!current || current.kind !== kind || current.bucket !== bucket) {
    return { kind, bucket, mode: "include" };
  }
  if (current.mode === "include") {
    return { kind, bucket, mode: "exclude" };
  }
  return null;
};

export const matchesBadgeFilter = <T extends ScoreEntry>(
  entry: T,
  filter: BadgeFilter,
): boolean => {
  if (!filter) {
    return true;
  }
  const matched = entryMatchesBadge(entry, filter.kind, filter.bucket);
  return filter.mode === "include" ? matched : !matched;
};

export function useBadgeScopeFilter() {
  const [pageFilter, setPageFilterState] = useState<BadgeFilter>(null);
  const [sectionFilters, setSectionFilters] = useState<
    Record<string, BadgeFilter>
  >({});

  const setPageFilter = useCallback((next: BadgeFilter) => {
    setPageFilterState(next);
    if (next) {
      setSectionFilters({});
    }
  }, []);

  const setSectionFilter = useCallback((key: string, next: BadgeFilter) => {
    setSectionFilters((prev) => ({ ...prev, [key]: next }));
    if (next) {
      setPageFilterState(null);
    }
  }, []);

  const effectiveFor = useCallback(
    (key: string): BadgeFilter => pageFilter ?? sectionFilters[key] ?? null,
    [pageFilter, sectionFilters],
  );

  return {
    pageFilter,
    sectionFilters,
    setPageFilter,
    setSectionFilter,
    effectiveFor,
  };
}

export const summarizeRanks = <T extends ScoreEntry>(
  entries: T[],
): RankSummary => {
  const counts = emptyCounts();
  for (const entry of entries) {
    const rank = scoreToRank(
      entry.score?.score ?? entry.score?.dxScore ?? null,
    );
    if (!rank) {
      continue;
    }
    const idx = rankOrder.indexOf(rank);
    for (let i = idx; i < rankOrder.length; i++) {
      counts[rankOrder[i]] += 1;
    }
  }
  return { counts, total: entries.length };
};

export const summarizeStatuses = <T extends ScoreEntry>(
  entries: T[],
): StatusSummary => {
  const { fc, fs } = emptyStatusCounts();
  for (const entry of entries) {
    const fcVal = entry.score?.fc?.toLowerCase?.() as FcBucket | undefined;
    const fsVal = entry.score?.fs?.toLowerCase?.() as FsBucket | undefined;
    if (fcVal && fcVal in fc) {
      fc[fcVal] += 1;
    }
    if (fsVal && fsVal in fs) {
      fs[fsVal] += 1;
    }
  }
  return { fc, fs, total: entries.length };
};

export const calculateAverageScore = <T extends ScoreEntry>(
  entries: T[],
): number | null => {
  if (entries.length === 0) {
    return null;
  }
  let sum = 0;
  let count = 0;
  for (const entry of entries) {
    const scoreText = entry.score?.score ?? entry.score?.dxScore ?? null;
    if (!scoreText) {
      continue;
    }
    const val = parseFloat(scoreText.replace("%", ""));
    if (Number.isFinite(val)) {
      sum += val;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
};
