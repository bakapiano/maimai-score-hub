import { ActionIcon, Box, Card, Group, Stack, Text } from "@mantine/core";
import React, { useState } from "react";

import type { SyncScore } from "../types/syncScore";
import { renderRank } from "./MusicScoreCard";

// Types
const rankOrder = ["SSS+", "SSS", "SS+", "SS", "S+", "S"] as const;
export type RankBucket = (typeof rankOrder)[number];

const fcOrder = ["ap+", "ap", "fc+", "fc"] as const;
const fsOrder = ["fsd+", "fsd", "fs+", "fs"] as const;
export type FcBucket = (typeof fcOrder)[number];
export type FsBucket = (typeof fsOrder)[number];

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
  fc: fcOrder.reduce<Record<FcBucket, number>>((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {} as Record<FcBucket, number>),
  fs: fsOrder.reduce<Record<FsBucket, number>>((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {} as Record<FsBucket, number>),
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

// Summarize functions
export const summarizeRanks = <T extends ScoreEntry>(
  entries: T[]
): RankSummary => {
  const counts = emptyCounts();
  for (const entry of entries) {
    const rank = scoreToRank(
      entry.score?.score ?? entry.score?.dxScore ?? null
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
  entries: T[]
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
  entries: T[]
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
}: {
  count: number;
  total: number;
  labelNode: React.ReactNode;
  compact?: boolean;
}) => (
  <Box
    style={{
      width: compact ? 80 : 106,
      padding: compact ? "2px 6px" : "4px 8px",
      borderRadius: 6,
      backgroundColor: "var(--mantine-color-gray-light)",
    }}
  >
    <Group gap={4} justify="space-between" wrap="nowrap">
      <Box style={{ width: compact ? 28 : 36 }}>{labelNode}</Box>
      <Text
        size={compact ? "xs" : "sm"}
        fw={600}
        style={{ whiteSpace: "nowrap" }}
      >
        {count}
        <Text span size="xs" fw={400}>
          /{total}
        </Text>
      </Text>
    </Group>
  </Box>
);

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

// FC/FS color helpers
const fcColor = (key: FcBucket) =>
  key === "ap+" || key === "ap" ? "orange" : "green";
const fsColor = (key: FsBucket) =>
  key === "fsd+" || key === "fsd" ? "orange" : "blue";
const statusLabel = (key: FcBucket | FsBucket) => key.toUpperCase();

// Main component - inline display with expand button
export type CombinedBadgesProps = {
  rankSummary: RankSummary;
  statusSummary: StatusSummary;
  defaultExpanded?: boolean;
};

export function CombinedBadges({
  rankSummary,
  statusSummary,
  defaultExpanded = false,
}: CombinedBadgesProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const rankList = expanded ? rankOrder : (["SSS+", "SSS"] as RankBucket[]);
  const fcList = expanded
    ? fcOrder
    : (["ap+", "ap", "fc+", "fc"] as FcBucket[]);
  const fsList = expanded ? fsOrder : ([] as FsBucket[]);

  return (
    <Group gap={6} wrap="wrap" align="center">
      {rankList.map((r) => (
        <StatItem
          key={r}
          count={rankSummary.counts[r]}
          total={rankSummary.total}
          compact
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
          labelNode={
            <Text size="xs" fw={600} c={fcColor(key)}>
              {statusLabel(key)}
            </Text>
          }
        />
      ))}
      {fsList.map((key) => (
        <StatItem
          key={`fs-${key}`}
          count={statusSummary.fs[key]}
          total={statusSummary.total}
          compact
          labelNode={
            <Text size="xs" fw={600} c={fsColor(key)}>
              {statusLabel(key)}
            </Text>
          }
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
};

export function ScoreSummaryCard({
  rankSummary,
  statusSummary,
  averageScore,
  defaultExpanded = false,
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

  return (
    <Card shadow="none" radius="md" p="md" withBorder>
      <Stack gap="sm">
        {/* 达成率统计 */}
        <Box>
          <Group gap={6} wrap="wrap">
            {rankList.map((r) => (
              <StatItem
                key={r}
                count={rankSummary.counts[r]}
                total={rankSummary.total}
                labelNode={
                  <Text size="sm" fw={600}>
                    {renderRank(r, { compact: true })}
                  </Text>
                }
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
          <Group gap={6} wrap="wrap">
            {fcList.map((key) => (
              <StatItem
                key={`fc-${key}`}
                count={statusSummary.fc[key]}
                total={statusSummary.total}
                labelNode={
                  <Text size="sm" fw={600} c={fcColor(key)}>
                    {statusLabel(key)}
                  </Text>
                }
              />
            ))}
            {fsList.map((key) => (
              <StatItem
                key={`fs-${key}`}
                count={statusSummary.fs[key]}
                total={statusSummary.total}
                labelNode={
                  <Text size="sm" fw={600} c={fsColor(key)}>
                    {statusLabel(key)}
                  </Text>
                }
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
