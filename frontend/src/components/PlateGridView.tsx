import { Box, Group, Image, Stack, Text } from "@mantine/core";
import type { MusicChartPayload, MusicRow } from "../types/music";
import {
  getCoverUrl,
  getIconUrl,
  getRankFromScore,
  renderRank,
} from "./MusicScoreCard/utils";

import { LEVEL_COLORS } from "./MusicScoreCard/constants";
import type { PlatePlan } from "../constants/platePlan";
import type { SyncScore } from "../types/syncScore";
import { CombinedBadges } from "./ScoreSummaryBadges";
import {
  matchesBadgeFilter,
  statusMeetsFcBucket,
  statusMeetsFsBucket,
  summarizeRanks,
  summarizeStatuses,
  type BadgeFilter,
} from "./ScoreSummaryBadges.model";
import { DeferredImage } from "./DeferredImage";

type ChartEntry = {
  music: MusicRow;
  chart: MusicChartPayload;
  chartIndex: number;
  score?: SyncScore;
};

type LevelGroup = {
  levelKey: string;
  levelNumeric: number | null;
  items: ChartEntry[];
};

export type PlateProgressEntry = {
  score?: Pick<SyncScore, "score" | "fc" | "fs">;
};

export type PlateCompletionDisplayMode = "classic" | "check";

export function isPlateEntryCompleted(
  entry: PlateProgressEntry,
  plan: PlatePlan,
): boolean {
  if (!entry.score) {return false;}
  switch (plan) {
    case "jiang": {
      const scoreText = entry.score.score ?? null;
      if (!scoreText) {return false;}
      const val = parseFloat(scoreText.replace("%", ""));
      return !isNaN(val) && val >= 100;
    }
    case "ji":
      return statusMeetsFcBucket(entry.score.fc, "fc");
    case "shen":
      return statusMeetsFcBucket(entry.score.fc, "ap");
    case "wuwu":
      return statusMeetsFsBucket(entry.score.fs, "fdx");
  }
}

const CARD_SIZE = 64;
const CARD_BORDER = 3;

function CompletedCheckOverlay() {
  return (
    <Box
      style={{
        position: "absolute",
        inset: 0,
        background:
          "linear-gradient(180deg, rgba(31, 41, 55, 0.42) 0%, rgba(15, 23, 42, 0.58) 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      <Box
        style={{
          width: 42,
          height: 42,
          borderRadius: 999,
          border: "3px solid rgb(0, 220, 165)",
          color: "rgb(0, 220, 165)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow:
            "0 1px 6px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.35)",
          textShadow: "0 1px 4px rgba(0,0,0,0.65)",
          transform: "rotate(-8deg)",
        }}
      >
        <Text fw={900} style={{ fontSize: 29, lineHeight: 1 }}>
          ✓
        </Text>
      </Box>
    </Box>
  );
}

function CompletedClassicOverlay({ children }: { children: React.ReactNode }) {
  return (
    <Box
      style={{
        position: "absolute",
        inset: 0,
        background:
          "linear-gradient(180deg, rgba(31, 41, 55, 0.42) 0%, rgba(15, 23, 42, 0.58) 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2,
      }}
    >
      {children}
    </Box>
  );
}

function PlateRankBadge({ rank }: { rank: string }) {
  return (
    <Box
      h={26}
      px={4}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        background: "rgba(16, 20, 28, 0.68)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
        backdropFilter: "blur(1px)",
        WebkitBackdropFilter: "blur(1px)",
      }}
    >
      {renderRank(rank, { compact: true, width: 48 })}
    </Box>
  );
}

function PlateCard({
  entry,
  plan,
  completionMode,
  onClick,
}: {
  entry: ChartEntry;
  plan: PlatePlan;
  completionMode: PlateCompletionDisplayMode;
  onClick?: () => void;
}) {
  const completed = isPlateEntryCompleted(entry, plan);
  const coverUrl = getCoverUrl(entry.music.id);

  // Determine which icon to show based on plan (matching reference project)
  const planIcon = (() => {
    if (!completed) {return null;}
    switch (plan) {
      case "jiang":
        return null; // 将牌: show rank text instead
      case "ji":
      case "shen":
        return entry.score?.fc ? getIconUrl(entry.score.fc) : null;
      case "wuwu":
        return entry.score?.fs ? getIconUrl(entry.score.fs) : null;
    }
  })();

  // For 将牌 mode, show rank for both completed and uncompleted (if has score)
  const rank =
    plan === "jiang" ? getRankFromScore(entry.score?.score ?? null) : null;
  const displayRank = rank && rank !== "N/A" ? rank : null;

  const diffColor = LEVEL_COLORS[entry.chartIndex] ?? "#888";

  return (
    <Box
      onClick={onClick}
      style={{
        width: CARD_SIZE,
        height: CARD_SIZE,
        cursor: onClick ? "pointer" : undefined,
        position: "relative",
        borderRadius: 4,
        overflow: "hidden",
        border: `${CARD_BORDER}px solid ${diffColor}`,
        boxSizing: "border-box",
      }}
    >
      <DeferredImage
        src={coverUrl}
        w="100%"
        h="100%"
        fit="cover"
      />

      {completed && completionMode === "check" && <CompletedCheckOverlay />}

      {completed && completionMode === "classic" && (
        <CompletedClassicOverlay>
          {planIcon ? (
            <Image src={planIcon} w={36} h={36} referrerPolicy="no-referrer" />
          ) : displayRank ? (
            <PlateRankBadge rank={displayRank} />
          ) : null}
        </CompletedClassicOverlay>
      )}

      {/* Uncompleted but has score: show rank without overlay */}
      {!completed && displayRank && (
        <Box
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 3,
          }}
        >
          <PlateRankBadge rank={displayRank} />
        </Box>
      )}
    </Box>
  );
}

type PlateGridViewProps = {
  levels: LevelGroup[];
  plan: PlatePlan;
  completionMode?: PlateCompletionDisplayMode;
  onCardClick?: (entry: ChartEntry) => void;
  pageFilter?: BadgeFilter;
  sectionFilters?: Record<string, BadgeFilter>;
  onSectionFilterChange?: (key: string, next: BadgeFilter) => void;
};

export function PlateGridView({
  levels,
  plan,
  completionMode = "check",
  onCardClick,
  pageFilter = null,
  sectionFilters,
  onSectionFilterChange,
}: PlateGridViewProps) {
  return (
    <Stack gap="lg">
      {levels.map((level) => {
        const sectionFilter = sectionFilters?.[level.levelKey] ?? null;
        const effectiveFilter = pageFilter ?? sectionFilter;
        const visibleItems = level.items.filter((entry) =>
          matchesBadgeFilter(entry, effectiveFilter),
        );
        return (
          <Stack key={level.levelKey} gap="xs">
            <Text fw={700}>{level.levelKey}</Text>
            <CombinedBadges
              rankSummary={summarizeRanks(level.items)}
              statusSummary={summarizeStatuses(level.items)}
              filter={sectionFilter}
              onFilterChange={
                onSectionFilterChange
                  ? (next) => onSectionFilterChange(level.levelKey, next)
                  : undefined
              }
            />
            <Group gap={6} wrap="wrap">
              {visibleItems.map((entry) => (
                <PlateCard
                  key={`${entry.music.id}-${entry.chartIndex}`}
                  entry={entry}
                  plan={plan}
                  completionMode={completionMode}
                  onClick={onCardClick ? () => onCardClick(entry) : undefined}
                />
              ))}
            </Group>
          </Stack>
        );
      })}
    </Stack>
  );
}
