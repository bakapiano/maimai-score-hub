import {
  ActionIcon,
  Badge,
  Box,
  Collapse,
  Group,
  Image,
  Paper,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useState } from "react";

import type { DetailedMusicScoreCardProps } from "./MusicScoreCard";
import classes from "./ScoreDetailModal.module.css";

const RATING_COEFFICIENT_TABLE = [
  [0, 0],
  [10, 1.6],
  [20, 3.2],
  [30, 4.8],
  [40, 6.4],
  [50, 8.0],
  [60, 9.6],
  [70, 11.2],
  [75, 12.0],
  [79.9999, 12.8],
  [80, 13.6],
  [90, 15.2],
  [94, 16.8],
  [96.9999, 17.6],
  [97, 20.0],
  [98, 20.3],
  [98.9999, 20.6],
  [99, 20.8],
  [99.5, 21.1],
  [99.9999, 21.4],
  [100, 21.6],
  [100.4999, 22.2],
  [100.5, 22.4],
] as const;

const RANK_ASSET_BASE = "/mai/pic";
const RANK_ASSET: Record<string, string> = {
  "SSS+": "UI_TTR_Rank_SSSp.png",
  SSS: "UI_TTR_Rank_SSS.png",
  "SS+": "UI_TTR_Rank_SSp.png",
  SS: "UI_TTR_Rank_SS.png",
  "S+": "UI_TTR_Rank_Sp.png",
  S: "UI_TTR_Rank_S.png",
  AAA: "UI_TTR_Rank_AAA.png",
  AA: "UI_TTR_Rank_AA.png",
  A: "UI_TTR_Rank_A.png",
  BBB: "UI_TTR_Rank_BBB.png",
  BB: "UI_TTR_Rank_BB.png",
  B: "UI_TTR_Rank_B.png",
  C: "UI_TTR_Rank_C.png",
  D: "UI_TTR_Rank_D.png",
};

type RatingThreshold = {
  achievement: number;
  rating: number;
};

function getRatingCoefficient(achievement: number) {
  for (let i = 0; i < RATING_COEFFICIENT_TABLE.length; i += 1) {
    const next = RATING_COEFFICIENT_TABLE[i + 1];
    if (!next || achievement < next[0]) {
      return RATING_COEFFICIENT_TABLE[i][1];
    }
  }
  return RATING_COEFFICIENT_TABLE[RATING_COEFFICIENT_TABLE.length - 1][1];
}

function calculateDxRating(chartConstant: number, achievement: number) {
  return Math.floor(
    getRatingCoefficient(achievement) *
      chartConstant *
      Math.min(100.5, achievement) /
      100,
  );
}

function buildRatingThresholds(chartConstant: number): RatingThreshold[] {
  const thresholds: RatingThreshold[] = [];
  let previousRating = calculateDxRating(chartConstant, 96.9999);

  for (let achievement4 = 970000; achievement4 <= 1010000; achievement4 += 1) {
    const achievement = achievement4 / 10000;
    const rating = calculateDxRating(chartConstant, achievement);
    if (rating > previousRating) {
      thresholds.push({ achievement, rating });
      previousRating = rating;
    }
  }

  return thresholds.sort((a, b) => b.achievement - a.achievement);
}

function getChartConstant(scoreData: DetailedMusicScoreCardProps) {
  const detailLevel = scoreData.chartPayload?.detailLevel;
  return typeof detailLevel === "number" ? detailLevel : null;
}

function getRankFromAchievement(achievement: number) {
  if (achievement >= 100.5) {return "SSS+";}
  if (achievement >= 100) {return "SSS";}
  if (achievement >= 99.5) {return "SS+";}
  if (achievement >= 99) {return "SS";}
  if (achievement >= 98) {return "S+";}
  if (achievement >= 97) {return "S";}
  if (achievement >= 94) {return "AAA";}
  if (achievement >= 90) {return "AA";}
  if (achievement >= 80) {return "A";}
  if (achievement >= 75) {return "BBB";}
  if (achievement >= 70) {return "BB";}
  if (achievement >= 60) {return "B";}
  if (achievement >= 50) {return "C";}
  return "D";
}

function getRatingBaseline(scoreData: DetailedMusicScoreCardProps) {
  const floor = scoreData.ratingFloor ?? 0;
  const current = typeof scoreData.rating === "number" ? scoreData.rating : 0;
  return Math.max(floor, current);
}

export function ScoreRatingCalculatorSection({
  scoreData,
}: {
  scoreData: DetailedMusicScoreCardProps;
}) {
  const [opened, setOpened] = useState(false);
  const chartConstant = getChartConstant(scoreData);
  const thresholds =
    chartConstant === null ? [] : buildRatingThresholds(chartConstant);
  const ratingBaseline = getRatingBaseline(scoreData);

  return (
    <Stack gap="sm" className={classes.ratingThresholdSection}>
      <Group justify="space-between" align="center" gap="xs">
        <Group gap="xs">
          <Text fw={700}>Rating 计算器</Text>
          {chartConstant !== null ? (
            <Badge variant="light" color="gray">
              定数 {chartConstant.toFixed(1)}
            </Badge>
          ) : null}
        </Group>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={opened ? "收起 Rating 计算器" : "展开 Rating 计算器"}
          onClick={() => setOpened((value) => !value)}
        >
          {opened ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </ActionIcon>
      </Group>
      <Collapse in={opened}>
        {chartConstant === null ? (
          <Paper withBorder className={classes.emptyChartData}>
            <Text size="sm" c="dimmed">
              当前谱面没有返回详细定数，无法计算 DX Rating 线。
            </Text>
          </Paper>
        ) : (
          <Box className={classes.ratingThresholdTableWrap}>
            <Table
              striped
              highlightOnHover
              withTableBorder
              horizontalSpacing="sm"
              verticalSpacing={4}
              stickyHeader
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>最低达成率</Table.Th>
                  <Table.Th>Rating</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {thresholds.map((threshold) => {
                  const rank = getRankFromAchievement(threshold.achievement);
                  return (
                    <Table.Tr key={`${threshold.rating}:${threshold.achievement}`}>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Image
                            src={`${RANK_ASSET_BASE}/${RANK_ASSET[rank]}`}
                            alt={rank}
                            className={classes.ratingThresholdRankImage}
                          />
                          <Text size="sm">
                            {threshold.achievement.toFixed(4)}%
                          </Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color="blue">
                          {threshold.rating}
                          （+{Math.max(0, threshold.rating - ratingBaseline)}）
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Collapse>
    </Stack>
  );
}
