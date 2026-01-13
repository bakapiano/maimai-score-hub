import {
  Box,
  Card,
  Divider,
  Group,
  LoadingOverlay,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  calculateAverageScore,
  CombinedBadges,
  ScoreSummaryCard,
  summarizeRanks,
  summarizeStatuses,
} from "../../components/ScoreSummaryBadges";
import type { MusicChartPayload, MusicRow } from "../../types/music";
import { useMemo, useState, useTransition } from "react";

import { MinimalMusicScoreCard } from "../../components/MusicScoreCard";
import type { SyncScore } from "../../types/syncScore";

type ChartEntry = {
  music: MusicRow;
  chart: MusicChartPayload;
  chartIndex: number;
  score?: SyncScore;
};

type LevelBucket = {
  levelKey: string;
  levelNumeric: number | null;
  details: Array<{
    detailKey: string;
    detailNumeric: number | null;
    items: ChartEntry[];
  }>;
};

const parseLevelValue = (value: string) => {
  const match = /^([0-9]+(?:\.[0-9]+)?)(\+)?$/.exec(value.trim());
  if (!match) return null;
  const base = parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  // Treat a trailing + as slightly higher than the base number
  return base + (match[2] ? 0.1 : 0);
};

const normalizeLevelKey = (chart: MusicChartPayload) => {
  if (chart.level) return chart.level;
  if (typeof chart.detailLevel === "number") {
    return Math.floor(chart.detailLevel).toString();
  }
  return "?";
};

const normalizeDetailKey = (chart: MusicChartPayload) => {
  if (typeof chart.detailLevel === "number")
    return chart.detailLevel.toFixed(1);
  if (chart.level) return chart.level;
  return "?";
};

const buildBuckets = (
  musics: MusicRow[],
  scores: SyncScore[]
): LevelBucket[] => {
  const scoreMap = new Map<string, SyncScore>();
  for (const s of scores) {
    const key = `${s.musicId}-${s.chartIndex}`;
    scoreMap.set(key, s);
  }

  const levelMap = new Map<string, Map<string, ChartEntry[]>>();

  for (const music of musics) {
    const charts = music.charts ?? [];
    charts.forEach((chart, idx) => {
      const levelKey = normalizeLevelKey(chart);
      const detailKey = normalizeDetailKey(chart);
      const levelBucket =
        levelMap.get(levelKey) ?? new Map<string, ChartEntry[]>();
      if (!levelMap.has(levelKey)) levelMap.set(levelKey, levelBucket);
      const detailBucket = levelBucket.get(detailKey) ?? [];
      if (!levelBucket.has(detailKey)) levelBucket.set(detailKey, detailBucket);

      detailBucket.push({
        music,
        chart,
        chartIndex: idx,
        score: scoreMap.get(`${music.id}-${idx}`),
      });
    });
  }

  const buckets: LevelBucket[] = Array.from(levelMap.entries()).map(
    ([levelKey, detailMap]) => ({
      levelKey,
      levelNumeric: parseLevelValue(levelKey),
      details: Array.from(detailMap.entries())
        .map(([detailKey, items]) => ({
          detailKey,
          detailNumeric: parseLevelValue(detailKey),
          items: items.sort(
            (a, b) => (b.score?.rating ?? 0) - (a.score?.rating ?? 0)
          ),
        }))
        .sort(
          (a, b) =>
            (a.detailNumeric ?? Infinity) - (b.detailNumeric ?? Infinity)
        ),
    })
  );

  buckets.sort((a, b) => {
    const numDiff =
      (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity);
    if (numDiff !== 0) return numDiff;
    return a.levelKey.localeCompare(b.levelKey);
  });

  return buckets;
};

type LevelScoresTabProps = {
  musics: MusicRow[];
  scores: SyncScore[];
  lastSyncAt: string | null;
  loading: boolean;
};

export function LevelScoresTab({
  musics,
  scores,
  loading,
}: LevelScoresTabProps) {
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filteredMusics = useMemo(
    () => musics.filter((m) => m.type !== "utage"),
    [musics]
  );
  const filteredScores = useMemo(
    () => scores.filter((s) => s.type !== "utage"),
    [scores]
  );

  const buckets = useMemo(
    () => buildBuckets(filteredMusics, filteredScores),
    [filteredMusics, filteredScores]
  );
  const current =
    buckets.find((b) => b.levelKey === selectedLevel) ?? buckets[0];

  const currentAllItems = useMemo(() => {
    if (!current) return [];
    return current.details.flatMap((d) => d.items);
  }, [current]);

  return (
    <Stack gap="md">
      <Box>
        <Group justify="space-between" align="center" mb="sm">
          <Title order={4} size="h5">
            按详细定数查看
          </Title>
        </Group>

        {buckets.length > 0 && (
          <Box style={{ overflowX: "auto" }}>
            <SegmentedControl
              value={current?.levelKey ?? ""}
              onChange={(value) =>
                startTransition(() => setSelectedLevel(value))
              }
              data={buckets.map((b) => ({
                value: b.levelKey,
                label: b.levelKey,
              }))}
              disabled={isPending}
              size="md"
              color="blue"
              styles={{
                label: { minWidth: 48, textAlign: "center" },
              }}
            />
          </Box>
        )}
      </Box>

      {current && currentAllItems.length > 0 && (
        <ScoreSummaryCard
          rankSummary={summarizeRanks(currentAllItems)}
          statusSummary={summarizeStatuses(currentAllItems)}
          averageScore={calculateAverageScore(currentAllItems)}
        />
      )}

      <Box pos="relative" mih={200}>
        <LoadingOverlay
          visible={isPending}
          zIndex={10}
          overlayProps={{ radius: "sm", blur: 2 }}
          loaderProps={{
            style: {
              position: "absolute",
              top: 80,
              left: "50%",
              transform: "translateX(-50%)",
            },
          }}
        />
        {loading ? (
          <Text size="sm">加载中...</Text>
        ) : !current ? (
          <Text size="sm" c="dimmed">
            暂无数据
          </Text>
        ) : (
          <Stack gap="lg">
            {current.details.map((detail, idx) => (
              <Stack key={`${current.levelKey}-${detail.detailKey}`} gap="xs">
                <Group align="center">
                  <Text fw={700}>{detail.detailKey}</Text>
                </Group>
                <CombinedBadges
                  rankSummary={summarizeRanks(detail.items)}
                  statusSummary={summarizeStatuses(detail.items)}
                />
                <Group
                  gap="sm"
                  align="stretch"
                  wrap="wrap"
                  style={{ width: "100%" }}
                >
                  {detail.items.map((entry) => (
                    <MinimalMusicScoreCard
                      key={`${entry.music.id}-${entry.chartIndex}`}
                      musicId={entry.music.id}
                      chartIndex={entry.chartIndex}
                      type={entry.music.type}
                      score={entry.score?.score || entry.score?.dxScore || null}
                      fs={entry.score?.fs ?? null}
                      fc={entry.score?.fc ?? null}
                    />
                  ))}
                </Group>
                {idx < current.details.length - 1 && (
                  <Divider variant="dashed" mt="md" mb="0" />
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
