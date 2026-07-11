import { ActionIcon, Box, Group, Stack, Text } from "@mantine/core";
import React, { useState } from "react";
import { useMediaQuery } from "@mantine/hooks";

import { renderMusicIcon, renderRank } from "./MusicScoreCard";
import { AppCard } from "./AppCard";
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

const COMPACT_STAT_MIN_WIDTH = 128;
const COMPACT_STAT_HEIGHT = 34;
const COMPACT_STAT_PADDING = "2px 6px";
const DENSE_STAT_WIDTH = 96;
const DENSE_RANK_WIDTH = 34;

function getStatItemLayout(compact: boolean, dense: boolean) {
  if (dense) {
    return {
      width: DENSE_STAT_WIDTH,
      minWidth: DENSE_STAT_WIDTH,
      height: COMPACT_STAT_HEIGHT,
      padding: "2px 4px",
      gap: 2,
      labelWidth: 40,
      textSize: "11px",
    } as const;
  }
  if (compact) {
    return {
      width: "fit-content",
      minWidth: COMPACT_STAT_MIN_WIDTH,
      height: COMPACT_STAT_HEIGHT,
      padding: COMPACT_STAT_PADDING,
      gap: 4,
      labelWidth: 52,
      textSize: "xs",
    } as const;
  }
  return {
    width: "fit-content",
    minWidth: 150,
    height: 40,
    padding: "4px 8px",
    gap: 4,
    labelWidth: 72,
    textSize: "sm",
  } as const;
}

// Shared StatItem component
const StatItem = ({
  count,
  total,
  labelNode,
  compact = false,
  dense = false,
  active = null,
  onClick,
}: {
  count: number;
  total: number;
  labelNode: React.ReactNode;
  compact?: boolean;
  dense?: boolean;
  active?: BadgeFilterMode | null;
  onClick?: () => void;
}) => {
  const layout = getStatItemLayout(compact, dense);
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
        width: layout.width,
        minWidth: layout.minWidth,
        height: layout.height,
        padding: layout.padding,
        borderRadius: 6,
        boxSizing: "border-box",
        backgroundColor,
        border: `1px solid ${borderColor}`,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
      }}
    >
      <Group
        gap={layout.gap}
        justify="space-between"
        wrap="nowrap"
        h="100%"
      >
        <Box
          style={{
            width: layout.labelWidth,
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
          size={layout.textSize}
          fw={600}
          style={{ whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {count}
          <Text span size={layout.textSize} fw={400}>
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
  leadingContent?: React.ReactNode;
  dense?: boolean;
};

export function CombinedBadges({
  rankSummary,
  statusSummary,
  defaultExpanded = false,
  filter = null,
  onFilterChange,
  leadingContent,
  dense = false,
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
      {leadingContent}
      {rankList.map((r) => (
        <StatItem
          key={r}
          count={rankSummary.counts[r]}
          total={rankSummary.total}
          compact
          dense={dense}
          active={activeOf("rank", r)}
          onClick={clickOf("rank", r)}
          labelNode={
            <Text size="xs" fw={600}>
              {renderRank(r, {
                compact: true,
                width: dense ? DENSE_RANK_WIDTH : undefined,
              })}
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
          dense={dense}
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
          dense={dense}
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

export type ScoreSectionSummaryProps = CombinedBadgesProps & {
  title: React.ReactNode;
};

export function ScoreSectionSummary({
  title,
  ...badgeProps
}: ScoreSectionSummaryProps) {
  const isMobile = useMediaQuery("(max-width: 48em)");
  const titleWithTotal = (
    <>
      {title}
      <Text component="span" size="xs" fw={500} c="dimmed" ml={4}>
        ({badgeProps.statusSummary.total})
      </Text>
    </>
  );

  if (isMobile) {
    return (
      <CombinedBadges
        {...badgeProps}
        dense
        leadingContent={
          <Box
            style={{
              width: DENSE_STAT_WIDTH,
              minWidth: DENSE_STAT_WIDTH,
              height: COMPACT_STAT_HEIGHT,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              flexShrink: 0,
            }}
          >
            <Text fw={700} style={{ whiteSpace: "nowrap" }}>
              {titleWithTotal}
            </Text>
          </Box>
        }
      />
    );
  }

  return (
    <Stack gap="xs">
      <Text fw={700}>{titleWithTotal}</Text>
      <CombinedBadges {...badgeProps} />
    </Stack>
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
    <AppCard>
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
    </AppCard>
  );
}
