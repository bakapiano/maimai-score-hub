import { ActionIcon, Box, Card, Group, Stack, Text } from "@mantine/core";
import React, { useState } from "react";
import { useMediaQuery } from "@mantine/hooks";

import { renderMusicIcon, renderRank } from "./MusicScoreCard";
import {
  cycleBadgeFilter,
  fcOrder,
  fsOrder,
  rankOrder,
  type BadgeFilter,
  type BadgeFilterKind,
  type BadgeFilterMode,
  type FcBucket,
  type FsBucket,
  type RankBucket,
  type RankSummary,
  type StatusSummary,
} from "./ScoreSummaryBadges.model";

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
const MOBILE_COLLAPSED_RANKS = ["SSS+", "SSS"] as RankBucket[];
const MOBILE_COLLAPSED_FC = ["ap", "fc"] as FcBucket[];

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
  const isMobile = useMediaQuery("(max-width: 48em)");

  const rankList = expanded ? rankOrder : (["SSS+", "SSS"] as RankBucket[]);
  const fcList = expanded
    ? fcOrder
    : isMobile
      ? MOBILE_COLLAPSED_FC
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
  const isMobile = useMediaQuery("(max-width: 48em)");

  const rankList = rankExpanded
    ? rankOrder
    : isMobile
      ? MOBILE_COLLAPSED_RANKS
      : (["SSS+", "SSS", "SS+", "SS"] as RankBucket[]);
  const fcList = statusExpanded
    ? fcOrder
    : isMobile
      ? MOBILE_COLLAPSED_FC
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
    <Card shadow="none" p="sm" withBorder>
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
