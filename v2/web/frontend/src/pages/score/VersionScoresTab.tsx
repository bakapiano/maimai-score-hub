import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import {
  Button,
  Card,
  Divider,
  Group,
  Select,
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
import { useMemo, useState } from "react";

import { MinimalMusicScoreCard } from "../../components/MusicScoreCard";
import type { SyncScore } from "../../types/syncScore";

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

type VersionBucket = {
  versionKey: string;
  levels: LevelGroup[];
};

const parseLevelValue = (value: string) => {
  const match = /^([0-9]+(?:\.[0-9]+)?)(\+)?$/.exec(value.trim());
  if (!match) return null;
  const base = parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  return base + (match[2] ? 0.1 : 0);
};

const normalizeLevelKey = (chart: MusicChartPayload) => {
  if (chart.level) return chart.level;
  if (typeof chart.detailLevel === "number")
    return chart.detailLevel.toFixed(1);
  return "?";
};

const detailSortValue = (chart: MusicChartPayload) => {
  if (typeof chart.detailLevel === "number") return chart.detailLevel;
  if (chart.level) {
    const parsed = parseLevelValue(chart.level);
    if (parsed !== null) return parsed;
  }
  return -Infinity;
};

const buildBuckets = (
  musics: MusicRow[],
  scores: SyncScore[]
): VersionBucket[] => {
  const scoreMap = new Map<string, SyncScore>();
  for (const s of scores) {
    const key = `${s.musicId}-${s.chartIndex}`;
    scoreMap.set(key, s);
  }

  const versionMap = new Map<string, Map<string, ChartEntry[]>>();

  for (const music of musics) {
    const charts = music.charts ?? [];
    const versionKey = music.version || "未知版本";
    const levelMap =
      versionMap.get(versionKey) ?? new Map<string, ChartEntry[]>();
    if (!versionMap.has(versionKey)) versionMap.set(versionKey, levelMap);

    charts.forEach((chart, idx) => {
      const levelKey = normalizeLevelKey(chart);
      const list = levelMap.get(levelKey) ?? [];
      if (!levelMap.has(levelKey)) levelMap.set(levelKey, list);

      list.push({
        music,
        chart,
        chartIndex: idx,
        score: scoreMap.get(`${music.id}-${idx}`),
      });
    });
  }

  const buckets: VersionBucket[] = Array.from(versionMap.entries()).map(
    ([versionKey, levelMap]) => ({
      versionKey,
      levels: Array.from(levelMap.entries())
        .map(([levelKey, items]) => ({
          levelKey,
          levelNumeric: parseLevelValue(levelKey),
          items: items.sort(
            (a, b) => detailSortValue(b.chart) - detailSortValue(a.chart)
          ),
        }))
        .sort(
          (a, b) =>
            (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity)
        ),
    })
  );

  // newest versions first (fallback alphabetic), unknown versions last
  buckets.sort((a, b) => {
    const aUnknown = a.versionKey === "未知版本";
    const bUnknown = b.versionKey === "未知版本";
    if (aUnknown && !bUnknown) return 1;
    if (!aUnknown && bUnknown) return -1;
    return b.versionKey.localeCompare(a.versionKey);
  });

  return buckets;
};

type VersionScoresTabProps = {
  musics: MusicRow[];
  scores: SyncScore[];
  lastSyncAt: string | null;
  loading: boolean;
};

export function VersionScoresTab({
  musics,
  scores,
  loading,
}: VersionScoresTabProps) {
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [showAllLevels, setShowAllLevels] = useState(false);

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
  const versionOptions = buckets.map((b) => ({
    value: b.versionKey,
    label: b.versionKey,
  }));
  const current =
    buckets.find((b) => b.versionKey === selectedVersion) ?? buckets[0];

  const detailThreshold = 13;

  const currentVisibleEntries = useMemo(() => {
    if (!current) return [] as ChartEntry[];
    return current.levels.flatMap((lvl) =>
      showAllLevels
        ? lvl.items
        : lvl.items.filter(
            (entry) => detailSortValue(entry.chart) >= detailThreshold
          )
    );
  }, [current, showAllLevels]);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Group gap={8} align="center">
          <Title order={4} size="h5">
            按版本查看
          </Title>
        </Group>
      </Group>

      {buckets.length > 0 && (
        <Select
          data={versionOptions}
          value={current?.versionKey ?? null}
          onChange={setSelectedVersion}
          // label="选择版本"
          placeholder="选择要查看的版本"
          clearable={false}
          searchable
        />
      )}

      {loading ? (
        <Text size="sm">加载中...</Text>
      ) : !current ? (
        <Text size="sm" c="dimmed">
          暂无数据
        </Text>
      ) : (
        <Stack gap="lg">
          <ScoreSummaryCard
            rankSummary={summarizeRanks(currentVisibleEntries)}
            statusSummary={summarizeStatuses(currentVisibleEntries)}
            averageScore={calculateAverageScore(currentVisibleEntries)}
          />

          {current.levels.map((level, idx) => {
            const visibleItems = showAllLevels
              ? level.items
              : level.items.filter(
                  (entry) => detailSortValue(entry.chart) >= detailThreshold
                );
            if (visibleItems.length === 0) return null;
            const isLastVisible = (() => {
              for (let j = idx + 1; j < current.levels.length; j++) {
                const nxt = current.levels[j];
                const nxtVisible = showAllLevels
                  ? nxt.items
                  : nxt.items.filter(
                      (entry) => detailSortValue(entry.chart) >= detailThreshold
                    );
                if (nxtVisible.length > 0) return false;
              }
              return true;
            })();

            return (
              <Stack key={`${current.versionKey}-${level.levelKey}`} gap="xs">
                <Group justify="space-between" align="center">
                  <Text fw={700}>{level.levelKey}</Text>
                </Group>
                <CombinedBadges
                  rankSummary={summarizeRanks(visibleItems)}
                  statusSummary={summarizeStatuses(visibleItems)}
                />
                <Group
                  gap="4"
                  align="stretch"
                  wrap="wrap"
                  style={{ width: "100%" }}
                >
                  {visibleItems.map((entry) => (
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
                {!isLastVisible && <Divider variant="dashed" mt="md" mb="0" />}
              </Stack>
            );
          })}

          <Group justify="center">
            <Button
              size="xs"
              variant="light"
              onClick={() => setShowAllLevels((v) => !v)}
              leftSection={
                showAllLevels ? (
                  <IconChevronUp size={16} />
                ) : (
                  <IconChevronDown size={16} />
                )
              }
            >
              {showAllLevels ? "隐藏低难度" : "显示全部"}
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
