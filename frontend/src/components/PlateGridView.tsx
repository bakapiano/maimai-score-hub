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
import {
  CombinedBadges,
  summarizeRanks,
  summarizeStatuses,
} from "./ScoreSummaryBadges";

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

function isCompleted(entry: ChartEntry, plan: PlatePlan): boolean {
  if (!entry.score) return false;
  switch (plan) {
    case "jiang": {
      const scoreText = entry.score.score ?? null;
      if (!scoreText) return false;
      const val = parseFloat(scoreText.replace("%", ""));
      return !isNaN(val) && val >= 100;
    }
    case "ji":
      return !!entry.score.fc;
    case "shen":
      return entry.score.fc === "ap" || entry.score.fc === "app";
    case "wuwu":
      return entry.score.fs === "fsd" || entry.score.fs === "fsdp";
  }
}

const CARD_SIZE = 64;
const CARD_BORDER = 3;

function PlateCard({
  entry,
  plan,
  onClick,
}: {
  entry: ChartEntry;
  plan: PlatePlan;
  onClick?: () => void;
}) {
  const completed = isCompleted(entry, plan);
  const coverUrl = getCoverUrl(entry.music.id);

  // Determine which icon to show based on plan (matching reference project)
  const planIcon = (() => {
    if (!completed) return null;
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
  const showRank = rank && rank !== "N/A";

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
      <Image
        src={coverUrl}
        w="100%"
        h="100%"
        fit="cover"
        fallbackSrc="https://placehold.co/58x58?text=?"
      />

      {/* Completed overlay with gradient */}
      {completed && (
        <Box
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(94, 209, 225, 0.55) 0%, rgba(189, 195, 254, 0.55) 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {planIcon ? (
            <Image src={planIcon} w={36} h={36} referrerPolicy="no-referrer" />
          ) : showRank ? (
            <Text
              fw={900}
              size="18px"
              style={{
                textShadow:
                  "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000",
                lineHeight: 1,
              }}
            >
              {renderRank(rank, { compact: true, stroke: true })}
            </Text>
          ) : null}
        </Box>
      )}

      {/* Uncompleted but has score: show rank without overlay */}
      {!completed && showRank && (
        <Box
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            fw={900}
            size="18px"
            style={{
              textShadow:
                "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000",
              lineHeight: 1,
            }}
          >
            {renderRank(rank, { compact: true, stroke: true })}
          </Text>
        </Box>
      )}
    </Box>
  );
}

type PlateGridViewProps = {
  levels: LevelGroup[];
  plan: PlatePlan;
  onCardClick?: (entry: ChartEntry) => void;
};

export function PlateGridView({
  levels,
  plan,
  onCardClick,
}: PlateGridViewProps) {
  return (
    <Stack gap="lg">
      {levels.map((level) => {
        return (
          <Stack key={level.levelKey} gap="xs">
            <Text fw={700}>{level.levelKey}</Text>
            <CombinedBadges
              rankSummary={summarizeRanks(level.items)}
              statusSummary={summarizeStatuses(level.items)}
            />
            <Group gap={6} wrap="wrap">
              {level.items.map((entry) => (
                <PlateCard
                  key={`${entry.music.id}-${entry.chartIndex}`}
                  entry={entry}
                  plan={plan}
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
