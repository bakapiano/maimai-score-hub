import {
  Box,
  Button,
  Group,
  LoadingOverlay,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import type { MusicChartPayload, MusicRow } from "../../types/music";
import { useMemo, useState, useTransition } from "react";

import { type DetailedMusicScoreCardProps } from "../../components/MusicScoreCard";
import { PlateGridView } from "../../components/PlateGridView";
import {
  ScoreSummaryCard,
  calculateAverageScore,
  summarizeRanks,
  summarizeStatuses,
  useBadgeScopeFilter,
} from "../../components/ScoreSummaryBadges";
import { PLAN_OPTIONS, type PlatePlan } from "../../constants/platePlan";
import { ScoreDetailModal } from "../../components/ScoreDetailModal";
import type { SyncScore } from "../../types/syncScore";
import {
  getVersionSortIndex,
  getVersionDisplayName,
  MAI_LEGACY_VERSIONS,
} from "../../constants/versions";
import { downloadBlob } from "../../utils/downloadBlob";
import { useAuth } from "../../providers/AuthProvider";

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
  scores: SyncScore[],
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
            (a, b) => detailSortValue(b.chart) - detailSortValue(a.chart),
          ),
        }))
        .sort(
          (a, b) =>
            (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity),
        ),
    }),
  );

  // Sort by predefined version order (newest first), unknown versions last
  buckets.sort((a, b) => {
    const aUnknown = a.versionKey === "未知版本";
    const bUnknown = b.versionKey === "未知版本";
    if (aUnknown && !bUnknown) return 1;
    if (!aUnknown && bUnknown) return -1;
    return (
      getVersionSortIndex(a.versionKey) - getVersionSortIndex(b.versionKey)
    );
  });

  return buckets;
};

/** Version pairs that share a plate and should be merged into one bucket */
const MERGE_GROUPS: { key: string; versions: string[] }[] = [
  { key: "maimai", versions: ["maimai", "maimai+"] },
];

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
  const { token } = useAuth();
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [exporting, setExporting] = useState(false);
  const [platePlan, setPlatePlan] = useState<PlatePlan>("jiang");
  const [showAllLevels, setShowAllLevels] = useState(false);
  const { pageFilter, sectionFilters, setPageFilter, setSectionFilter } =
    useBadgeScopeFilter();

  // Modal state for score detail
  const [modalOpened, setModalOpened] = useState(false);
  const [selectedScore, setSelectedScore] =
    useState<DetailedMusicScoreCardProps | null>(null);

  const handleScoreClick = (entry: ChartEntry) => {
    setSelectedScore({
      musicId: entry.music.id,
      chartIndex: entry.chartIndex,
      type: entry.music.type,
      rating: entry.score?.rating ?? null,
      score: entry.score?.score || null,
      fs: entry.score?.fs ?? null,
      fc: entry.score?.fc ?? null,
      dxScore: entry.score?.dxScore || null,
      chartPayload: entry.chart || null,
      songMetadata: {
        title: entry.music.title,
        artist: entry.music.artist,
        category: entry.music.category,
        isNew: entry.music.isNew,
        bpm: entry.music.bpm,
        version: entry.music.version,
      },
      bpm:
        typeof entry.music.bpm === "number"
          ? entry.music.bpm
          : parseInt(entry.music.bpm as string) || null,
      noteDesigner: entry.chart?.charter || null,
    });
    setModalOpened(true);
  };

  const filteredMusics = useMemo(
    () => musics.filter((m) => m.type !== "utage"),
    [musics],
  );
  const filteredScores = useMemo(
    () => scores.filter((s) => s.type !== "utage"),
    [scores],
  );

  const buckets = useMemo(
    () => buildBuckets(filteredMusics, filteredScores),
    [filteredMusics, filteredScores],
  );

  // Merge version groups that share a plate (e.g. maimai + maimai+ → 真代)
  const mergedBuckets = useMemo(() => {
    const result = [...buckets];
    for (const group of MERGE_GROUPS) {
      const indices = group.versions
        .map((v) => result.findIndex((b) => b.versionKey === v))
        .filter((i) => i !== -1);
      if (indices.length <= 1) continue;

      // Merge into the first one
      const mergedLevelMap = new Map<string, ChartEntry[]>();
      for (const idx of indices) {
        for (const level of result[idx].levels) {
          const list = mergedLevelMap.get(level.levelKey) ?? [];
          if (!mergedLevelMap.has(level.levelKey))
            mergedLevelMap.set(level.levelKey, list);
          list.push(...level.items);
        }
      }
      const merged: VersionBucket = {
        versionKey: group.key,
        levels: Array.from(mergedLevelMap.entries())
          .map(([levelKey, items]) => ({
            levelKey,
            levelNumeric: parseLevelValue(levelKey),
            items: items.sort(
              (a, b) => detailSortValue(b.chart) - detailSortValue(a.chart),
            ),
          }))
          .sort(
            (a, b) =>
              (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity),
          ),
      };
      // Replace first, remove rest
      result[indices[0]] = merged;
      for (let i = indices.length - 1; i >= 1; i--) {
        result.splice(indices[i], 1);
      }
    }
    return result;
  }, [buckets]);

  // Build "舞代" virtual bucket: all legacy versions (maimai → FiNALE) merged
  const maiBucket = useMemo(() => {
    const legacyBuckets = mergedBuckets.filter((b) =>
      MAI_LEGACY_VERSIONS.includes(b.versionKey),
    );
    if (legacyBuckets.length === 0) return null;
    const mergedLevelMap = new Map<string, ChartEntry[]>();
    for (const bucket of legacyBuckets) {
      for (const level of bucket.levels) {
        const list = mergedLevelMap.get(level.levelKey) ?? [];
        if (!mergedLevelMap.has(level.levelKey))
          mergedLevelMap.set(level.levelKey, list);
        list.push(...level.items);
      }
    }
    return {
      versionKey: "__mai__",
      levels: Array.from(mergedLevelMap.entries())
        .map(([levelKey, items]) => ({
          levelKey,
          levelNumeric: parseLevelValue(levelKey),
          items: items.sort(
            (a, b) => detailSortValue(b.chart) - detailSortValue(a.chart),
          ),
        }))
        .sort(
          (a, b) =>
            (b.levelNumeric ?? -Infinity) - (a.levelNumeric ?? -Infinity),
        ),
    } as VersionBucket;
  }, [mergedBuckets]);

  const allBuckets = useMemo(() => {
    const list = [...mergedBuckets];
    if (maiBucket) {
      // Insert 舞代 between finale and 舞萌DX
      const dxIndex = list.findIndex((b) => b.versionKey === "舞萌DX");
      if (dxIndex !== -1) {
        list.splice(dxIndex + 1, 0, maiBucket);
      } else {
        list.push(maiBucket);
      }
    }
    return list;
  }, [mergedBuckets, maiBucket]);

  const versionOptions = allBuckets.map((b) => ({
    value: b.versionKey,
    label:
      b.versionKey === "__mai__"
        ? "旧框 (舞代)"
        : getVersionDisplayName(b.versionKey),
  }));
  const current =
    allBuckets.find((b) => b.versionKey === selectedVersion) ?? allBuckets[0];

  const handleExport = async () => {
    if (!token || !current) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({
        version: current.versionKey,
        plan: platePlan,
      });
      const res = await fetch(
        `/api/v1/me/score-exports/version?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        throw new Error(`导出失败 (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      downloadBlob(blob, `version-${current.versionKey}-${platePlan}.png`);
    } catch (err) {
      console.error(err);
      alert((err as Error).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Stack gap="md">
      <ScoreDetailModal
        opened={modalOpened}
        onClose={() => setModalOpened(false)}
        scoreData={selectedScore}
      />
      <Group justify="space-between" align="center">
        <Group gap={8} align="center">
          <Title order={4} size="h5">
            按版本查看
          </Title>
          <SegmentedControl
            size="xs"
            value={platePlan}
            onChange={(v) =>
              startTransition(() => setPlatePlan(v as PlatePlan))
            }
            data={PLAN_OPTIONS}
          />
        </Group>
        <Group gap="xs" align="center">
          <Switch
            size="xs"
            labelPosition="left"
            label="显示全部"
            checked={showAllLevels}
            onChange={(e) =>
              startTransition(() => setShowAllLevels(e.currentTarget.checked))
            }
          />
          <Button
            size="xs"
            variant="default"
            leftSection={<IconDownload size={14} />}
            onClick={handleExport}
            loading={exporting}
            disabled={!token || !current}
          >
            导出图片
          </Button>
        </Group>
      </Group>

      {buckets.length > 0 && (
        <Select
          data={versionOptions}
          value={current?.versionKey ?? null}
          onChange={(value) => startTransition(() => setSelectedVersion(value))}
          placeholder="选择要查看的版本"
          clearable={false}
          searchable
          disabled={isPending}
        />
      )}

      {loading ? (
        <Text size="sm">加载中...</Text>
      ) : !current ? (
        <Text size="sm" c="dimmed">
          暂无数据
        </Text>
      ) : (
        <Box pos="relative" mih={200}>
          <LoadingOverlay
            visible={isPending}
            zIndex={10}
            overlayProps={{ radius: "sm", blur: 2 }}
          />
          <Stack gap="md">
            <ScoreSummaryCard
              rankSummary={summarizeRanks(
                (showAllLevels
                  ? current.levels
                  : current.levels.filter(
                      (lvl) => (lvl.levelNumeric ?? 0) >= 13,
                    )
                ).flatMap((lvl) =>
                  current.versionKey === "__mai__"
                    ? lvl.items
                    : lvl.items.filter((e) => e.chartIndex !== 4),
                ),
              )}
              statusSummary={summarizeStatuses(
                (showAllLevels
                  ? current.levels
                  : current.levels.filter(
                      (lvl) => (lvl.levelNumeric ?? 0) >= 13,
                    )
                ).flatMap((lvl) =>
                  current.versionKey === "__mai__"
                    ? lvl.items
                    : lvl.items.filter((e) => e.chartIndex !== 4),
                ),
              )}
              averageScore={calculateAverageScore(
                (showAllLevels
                  ? current.levels
                  : current.levels.filter(
                      (lvl) => (lvl.levelNumeric ?? 0) >= 13,
                    )
                ).flatMap((lvl) =>
                  current.versionKey === "__mai__"
                    ? lvl.items
                    : lvl.items.filter((e) => e.chartIndex !== 4),
                ),
              )}
              filter={pageFilter}
              onFilterChange={setPageFilter}
            />
            <PlateGridView
              levels={(showAllLevels
                ? current.levels
                : current.levels.filter((lvl) => (lvl.levelNumeric ?? 0) >= 13)
              )
                .map((lvl) =>
                  current.versionKey === "__mai__"
                    ? lvl
                    : {
                        ...lvl,
                        items: lvl.items.filter((e) => e.chartIndex !== 4),
                      },
                )
                .filter((lvl) => lvl.items.length > 0)}
              plan={platePlan}
              onCardClick={handleScoreClick}
              pageFilter={pageFilter}
              sectionFilters={sectionFilters}
              onSectionFilterChange={setSectionFilter}
            />
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
