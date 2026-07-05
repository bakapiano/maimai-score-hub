import { ActionIcon, Box, Card, Group, Stack, Text } from "@mantine/core";
import React, { useCallback, useState } from "react";

import type { SyncScore } from "../types/syncScore";
import { renderMusicIcon, renderRank } from "./MusicScoreCard";

// Types
const rankOrder = ["SSS+", "SSS", "SS+", "SS", "S+", "S"] as const;
export type RankBucket = (typeof rankOrder)[number];

const fcOrder = ["ap+", "ap", "fc+", "fc"] as const;
const fsOrder = ["fsd+", "fsd", "fs+", "fs"] as const;
export type FcBucket = (typeof fcOrder)[number];
export type FsBucket = (typeof fsOrder)[number];

// --- Badge-driven filtering ---------------------------------------------
// A badge can act as a 3-state filter on its scope:
//   none → include (only matching) → exclude (only non-matching) → none
export type BadgeFilterKind = "rank" | "fc" | "fs";
export type BadgeFilterMode = "include" | "exclude";
export type BadgeFilter = {
  kind: BadgeFilterKind;
  bucket: string;
  mode: BadgeFilterMode;
} | null;

// Cumulative thresholds for rank badges (badge counts are "this rank or above").
const RANK_THRESHOLD: Record<RankBucket, number> = {
  "SSS+": 100.5,
  SSS: 100,
  "SS+": 99.5,
  SS: 99,
  "S+": 98,
  S: 97,
};

export const cycleBadgeFilter = (
  current: BadgeFilter,
  kind: BadgeFilterKind,
  bucket: string,
): BadgeFilter => {
  if (!current || current.kind !== kind || current.bucket !== bucket) {
    return { kind, bucket, mode: "include" };
  }
  if (current.mode === "include") return { kind, bucket, mode: "exclude" };
  return null;
};

export type RankSummary = {
  counts: Record<RankBucket, number>;
  total: number;
};

export type StatusSummary = {
  fc: Record<FcBucket, number>;
  fs: Record<FsBucket, number>;
  total: number;
};

// Helper functions
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
  if (!scoreText) return null;
  const val = parseFloat(scoreText.replace("%", ""));
  if (!Number.isFinite(val)) return null;
  if (val >= 100.5) return "SSS+";
  if (val >= 100) return "SSS";
  if (val >= 99.5) return "SS+";
  if (val >= 99) return "SS";
  if (val >= 98) return "S+";
  if (val >= 97) return "S";
  return null;
};

// Entry type for summarization
type ScoreEntry = {
  score?: Pick<SyncScore, "score" | "dxScore" | "fc" | "fs">;
};

const entryMatchesBadge = (
  entry: ScoreEntry,
  kind: BadgeFilterKind,
  bucket: string,
): boolean => {
  if (kind === "rank") {
    const threshold = RANK_THRESHOLD[bucket as RankBucket];
    if (threshold === undefined) return false;
    const text = entry.score?.score ?? entry.score?.dxScore ?? null;
    if (!text) return false;
    const val = parseFloat(text.replace("%", ""));
    return Number.isFinite(val) && val >= threshold;
  }
  // fc / fs match the displayed badge counts (exact bucket, see summarizeStatuses)
  if (kind === "fc") return entry.score?.fc?.toLowerCase?.() === bucket;
  return entry.score?.fs?.toLowerCase?.() === bucket;
};

export const matchesBadgeFilter = <T extends ScoreEntry>(
  entry: T,
  filter: BadgeFilter,
): boolean => {
  if (!filter) return true;
  const matched = entryMatchesBadge(entry, filter.kind, filter.bucket);
  return filter.mode === "include" ? matched : !matched;
};

/**
 * Two-scope badge filtering: a page-level filter (from the top summary card)
 * and per-section filters (from each section's badges). The two scopes are
 * mutually exclusive — setting one clears the other.
 */
export function useBadgeScopeFilter() {
  const [pageFilter, setPageFilterState] = useState<BadgeFilter>(null);
  const [sectionFilters, setSectionFilters] = useState<
    Record<string, BadgeFilter>
  >({});

  const setPageFilter = useCallback((next: BadgeFilter) => {
    setPageFilterState(next);
    if (next) setSectionFilters({});
  }, []);

  const setSectionFilter = useCallback((key: string, next: BadgeFilter) => {
    setSectionFilters((prev) => ({ ...prev, [key]: next }));
    if (next) setPageFilterState(null);
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

// Summarize functions
export const summarizeRanks = <T extends ScoreEntry>(
  entries: T[],
): RankSummary => {
  const counts = emptyCounts();
  for (const entry of entries) {
    const rank = scoreToRank(
      entry.score?.score ?? entry.score?.dxScore ?? null,
    );
    if (!rank) continue;
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
    if (fcVal && fcVal in fc) fc[fcVal] += 1;
    if (fsVal && fsVal in fs) fs[fsVal] += 1;
  }
  return { fc, fs, total: entries.length };
};

// Calculate average score
export const calculateAverageScore = <T extends ScoreEntry>(
  entries: T[],
): number | null => {
  if (entries.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const entry of entries) {
    const scoreText = entry.score?.score ?? entry.score?.dxScore ?? null;
    if (!scoreText) continue;
    const val = parseFloat(scoreText.replace("%", ""));
    if (Number.isFinite(val)) {
      sum += val;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
};

// Shared StatItem component
const StatItem = ({
  count,
  total,
  labelNode,
  compact = false,
  active = null,
  onClick,
}: {
  count: number;
  total: number;
  labelNode: React.ReactNode;
  compact?: boolean;
  active?: BadgeFilterMode | null;
  onClick?: () => void;
}) => {
  const backgroundColor =
    active === "include"
      ? "var(--mantine-color-blue-light)"
      : active === "exclude"
        ? "var(--mantine-color-red-light)"
        : "var(--mantine-color-gray-light)";
  const borderColor =
    active === "include"
      ? "var(--mantine-color-blue-filled)"
      : active === "exclude"
        ? "var(--mantine-color-red-filled)"
        : "transparent";
  return (
    <Box
      onClick={onClick}
      role={onClick ? "button" : undefined}
      title={
        active === "include"
          ? "仅显示符合项（再点反选 / 第三次还原）"
          : active === "exclude"
            ? "仅显示不符合项（再点还原）"
            : undefined
      }
      style={{
        width: "fit-content",
        minWidth: compact ? 128 : 150,
        height: compact ? 34 : 40,
        padding: compact ? "2px 6px" : "4px 8px",
        borderRadius: 6,
        boxSizing: "border-box",
        backgroundColor,
        border: `1px solid ${borderColor}`,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
      }}
    >
      <Group gap={4} justify="space-between" wrap="nowrap" h="100%">
        <Box
          style={{
            width: compact ? 52 : 72,
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            flex: "0 0 auto",
          }}
        >
          {labelNode}
        </Box>
        <Text
          size={compact ? "xs" : "sm"}
          fw={600}
          style={{ whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {count}
          <Text span size="xs" fw={400}>
            /{total}
          </Text>
        </Text>
      </Group>
    </Box>
  );
};

// Shared ExpandButton component
const ExpandButton = ({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) => (
  <ActionIcon
    size="24"
    variant="light"
    color="blue"
    radius="xl"
    onClick={onClick}
    aria-label={expanded ? "收起" : "展开"}
  >
    <Text size="sm" fw={700} style={{ lineHeight: 1 }}>
      {expanded ? "−" : "+"}
    </Text>
  </ActionIcon>
);

const statusLabel = (key: FcBucket | FsBucket) => key.toUpperCase();

// Main component - inline display with expand button
export type CombinedBadgesProps = {
  rankSummary: RankSummary;
  statusSummary: StatusSummary;
  defaultExpanded?: boolean;
  filter?: BadgeFilter;
  onFilterChange?: (next: BadgeFilter) => void;
};

export function CombinedBadges({
  rankSummary,
  statusSummary,
  defaultExpanded = false,
  filter = null,
  onFilterChange,
}: CombinedBadgesProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const rankList = expanded ? rankOrder : (["SSS+", "SSS"] as RankBucket[]);
  const fcList = expanded
    ? fcOrder
    : (["ap+", "ap", "fc+", "fc"] as FcBucket[]);
  const fsList = expanded ? fsOrder : ([] as FsBucket[]);

  const activeOf = (kind: BadgeFilterKind, bucket: string) =>
    filter && filter.kind === kind && filter.bucket === bucket
      ? filter.mode
      : null;
  const clickOf = (kind: BadgeFilterKind, bucket: string) =>
    onFilterChange
      ? () => onFilterChange(cycleBadgeFilter(filter, kind, bucket))
      : undefined;

  return (
    <Group gap={6} wrap="wrap" align="center">
      {rankList.map((r) => (
        <StatItem
          key={r}
          count={rankSummary.counts[r]}
          total={rankSummary.total}
          compact
          active={activeOf("rank", r)}
          onClick={clickOf("rank", r)}
          labelNode={
            <Text size="xs" fw={600}>
              {renderRank(r, { compact: true })}
            </Text>
          }
        />
      ))}
      {fcList.map((key) => (
        <StatItem
          key={`fc-${key}`}
          count={statusSummary.fc[key]}
          total={statusSummary.total}
          compact
          active={activeOf("fc", key)}
          onClick={clickOf("fc", key)}
          labelNode={renderMusicIcon(key, {
            compact: true,
            alt: statusLabel(key),
          })}
        />
      ))}
      {fsList.map((key) => (
        <StatItem
          key={`fs-${key}`}
          count={statusSummary.fs[key]}
          total={statusSummary.total}
          compact
          active={activeOf("fs", key)}
          onClick={clickOf("fs", key)}
          labelNode={renderMusicIcon(key, {
            compact: true,
            alt: statusLabel(key),
          })}
        />
      ))}
      <ExpandButton
        expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      />
    </Group>
  );
}

// Two-column layout component for Card display
export type ScoreSummaryCardProps = {
  rankSummary: RankSummary;
  statusSummary: StatusSummary;
  averageScore?: number | null;
  size?: "xs" | "sm";
  defaultExpanded?: boolean;
  filter?: BadgeFilter;
  onFilterChange?: (next: BadgeFilter) => void;
};

export function ScoreSummaryCard({
  rankSummary,
  statusSummary,
  averageScore,
  defaultExpanded = false,
  filter = null,
  onFilterChange,
}: ScoreSummaryCardProps) {
  const [rankExpanded, setRankExpanded] = useState(defaultExpanded);
  const [statusExpanded, setStatusExpanded] = useState(defaultExpanded);

  const rankList = rankExpanded
    ? rankOrder
    : (["SSS+", "SSS", "SS+", "SS"] as RankBucket[]);
  const fcList = statusExpanded
    ? fcOrder
    : (["ap+", "ap", "fc+", "fc"] as FcBucket[]);
  const fsList = statusExpanded ? fsOrder : ([] as FsBucket[]);

  const activeOf = (kind: BadgeFilterKind, bucket: string) =>
    filter && filter.kind === kind && filter.bucket === bucket
      ? filter.mode
      : null;
  const clickOf = (kind: BadgeFilterKind, bucket: string) =>
    onFilterChange
      ? () => onFilterChange(cycleBadgeFilter(filter, kind, bucket))
      : undefined;

  return (
    <Card shadow="none" radius="md" p="sm" withBorder>
      <Stack gap="sm">
        {/* 达成率统计 */}
        <Box>
          <Group gap={4} wrap="wrap">
            {rankList.map((r) => (
              <StatItem
                key={r}
                count={rankSummary.counts[r]}
                total={rankSummary.total}
                active={activeOf("rank", r)}
                onClick={clickOf("rank", r)}
                labelNode={
                  <Text size="sm" fw={600}>
                    {renderRank(r, { compact: true })}
                  </Text>
                }
                compact
              />
            ))}
            <ExpandButton
              expanded={rankExpanded}
              onClick={() => setRankExpanded((prev) => !prev)}
            />
          </Group>
        </Box>

        {/* FC / FS 统计 */}
        <Box>
          <Group gap={4} wrap="wrap">
            {fcList.map((key) => (
              <StatItem
                key={`fc-${key}`}
                count={statusSummary.fc[key]}
                total={statusSummary.total}
                active={activeOf("fc", key)}
                onClick={clickOf("fc", key)}
                labelNode={renderMusicIcon(key, {
                  compact: true,
                  alt: statusLabel(key),
                })}
                compact
              />
            ))}
            {fsList.map((key) => (
              <StatItem
                key={`fs-${key}`}
                count={statusSummary.fs[key]}
                total={statusSummary.total}
                active={activeOf("fs", key)}
                onClick={clickOf("fs", key)}
                labelNode={renderMusicIcon(key, {
                  compact: true,
                  alt: statusLabel(key),
                })}
                compact
              />
            ))}
            <ExpandButton
              expanded={statusExpanded}
              onClick={() => setStatusExpanded((prev) => !prev)}
            />
          </Group>
        </Box>

        {/* 平均达成率 */}
        {typeof averageScore === "number" && (
          <Group gap="0" align="baseline">
            <Text size="xs" c="dimmed" fw={500}>
              平均达成率：
            </Text>
            <Text size="lg" fw={700}>
              {averageScore.toFixed(4)}%
            </Text>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
