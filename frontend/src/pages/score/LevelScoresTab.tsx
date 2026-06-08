import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  LoadingOverlay,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  CombinedBadges,
  ScoreSummaryCard,
  calculateAverageScore,
  matchesBadgeFilter,
  summarizeRanks,
  summarizeStatuses,
  useBadgeScopeFilter,
} from "../../components/ScoreSummaryBadges";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
} from "@tabler/icons-react";
import type { MusicChartPayload, MusicRow } from "../../types/music";
import { useMemo, useRef, useState, useTransition } from "react";

import {
  MinimalMusicScoreCard,
  type DetailedMusicScoreCardProps,
} from "../../components/MusicScoreCard";
import { ScoreDetailModal } from "../../components/ScoreDetailModal";
import {
  ScoreDisplayFilter,
  type DisplayFilterSettings,
  DEFAULT_DISPLAY_FILTER,
  matchesScoreFilter,
} from "../../components/ScoreDisplayFilter";
import type { SyncScore } from "../../types/syncScore";
import classes from "./LevelScoresTab.module.css";
import { useAuth } from "../../providers/AuthProvider";

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
  scores: SyncScore[],
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
            (a, b) => (b.score?.rating ?? 0) - (a.score?.rating ?? 0),
          ),
        }))
        .sort(
          (a, b) =>
            (b.detailNumeric ?? -Infinity) - (a.detailNumeric ?? -Infinity),
        ),
    }),
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
  const { token } = useAuth();
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [exporting, setExporting] = useState(false);
  const [displayFilter, setDisplayFilter] = useState<DisplayFilterSettings>(
    DEFAULT_DISPLAY_FILTER,
  );
  const { pageFilter, sectionFilters, setPageFilter, setSectionFilter } =
    useBadgeScopeFilter();

  // Modal state
  const [modalOpened, setModalOpened] = useState(false);
  const [selectedScore, setSelectedScore] =
    useState<DetailedMusicScoreCardProps | null>(null);

  const handleScoreClick = (entry: ChartEntry) => {
    setSelectedScore({
      musicId: entry.music.id,
      chartIndex: entry.chartIndex,
      type: entry.music.type,
      rating: entry.score?.rating ?? null,
      score: entry.score?.score || entry.score?.dxScore || null,
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
  const current =
    buckets.find((b) => b.levelKey === selectedLevel) ?? buckets[0];

  const currentAllItems = useMemo(() => {
    if (!current) return [];
    return current.details.flatMap((d) => d.items);
  }, [current]);

  const currentFilteredItems = useMemo(() => {
    return currentAllItems.filter((entry) =>
      matchesScoreFilter(
        entry.score?.score || entry.score?.dxScore || null,
        displayFilter,
      ),
    );
  }, [currentAllItems, displayFilter]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeftPos = useRef(0);

  const scrollLeft = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({ left: -150, behavior: "smooth" });
    }
  };

  const scrollRight = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({ left: 150, behavior: "smooth" });
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    isDragging.current = true;
    startX.current = e.pageX - scrollContainerRef.current.offsetLeft;
    scrollLeftPos.current = scrollContainerRef.current.scrollLeft;
    scrollContainerRef.current.style.cursor = "grabbing";
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current || !scrollContainerRef.current) return;
    e.preventDefault();
    const x = e.pageX - scrollContainerRef.current.offsetLeft;
    const walk = (x - startX.current) * 1.5;
    scrollContainerRef.current.scrollLeft = scrollLeftPos.current - walk;
  };

  const handleMouseUp = () => {
    isDragging.current = false;
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.cursor = "grab";
    }
  };

  const handleMouseLeave = () => {
    isDragging.current = false;
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.cursor = "grab";
    }
  };

  const handleExport = async () => {
    if (!token || !current) return;
    setExporting(true);
    try {
      const res = await fetch(
        `/api/score-export/level?level=${encodeURIComponent(current.levelKey)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        throw new Error(`导出失败 (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `level-${current.levelKey}.png`;
      a.click();
      URL.revokeObjectURL(url);
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
      <Box>
        <Group justify="space-between" align="center" mb="sm">
          <Title order={4} size="h5">
            按详细定数查看
          </Title>
          <Group gap="xs">
            <ScoreDisplayFilter
              value={displayFilter}
              onChange={setDisplayFilter}
            />
            <Button
              size="xs"
              variant="default"
              leftSection={<IconDownload size={14} />}
              onClick={handleExport}
              loading={exporting}
            >
              导出图片
            </Button>
          </Group>
        </Group>

        {buckets.length > 0 && (
          <Box pos="relative">
            <ActionIcon
              variant="filled"
              color="blue"
              size="md"
              radius="xl"
              onClick={scrollLeft}
              aria-label="向左滚动"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                margin: "auto 0",
                zIndex: 10,
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
              }}
            >
              <IconChevronLeft size={18} />
            </ActionIcon>
            <Box
              ref={scrollContainerRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              style={{
                overflowX: "auto",
                scrollbarWidth: "none",
                msOverflowStyle: "none",
                WebkitOverflowScrolling: "touch",
                touchAction: "pan-x",
                cursor: "grab",
                userSelect: "none",
                paddingLeft: 36,
                paddingRight: 36,
              }}
            >
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
                className={classes.levelSelector}
              />
            </Box>
            <ActionIcon
              variant="filled"
              color="blue"
              size="md"
              radius="xl"
              onClick={scrollRight}
              aria-label="向右滚动"
              style={{
                position: "absolute",
                right: 0,
                top: 0,
                bottom: 0,
                margin: "auto 0",
                zIndex: 10,
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
              }}
            >
              <IconChevronRight size={18} />
            </ActionIcon>
          </Box>
        )}
      </Box>

      {current && currentFilteredItems.length > 0 && (
        <ScoreSummaryCard
          rankSummary={summarizeRanks(currentFilteredItems)}
          statusSummary={summarizeStatuses(currentFilteredItems)}
          averageScore={calculateAverageScore(currentFilteredItems)}
          filter={pageFilter}
          onFilterChange={setPageFilter}
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
            {current.details.map((detail, idx) => {
              const baseItems = detail.items.filter((entry) =>
                matchesScoreFilter(
                  entry.score?.score || entry.score?.dxScore || null,
                  displayFilter,
                ),
              );
              if (baseItems.length === 0) return null;
              const sectionKey = `${current.levelKey}-${detail.detailKey}`;
              const sectionFilter = sectionFilters[sectionKey] ?? null;
              const effectiveFilter = pageFilter ?? sectionFilter;
              const visibleItems = baseItems.filter((entry) =>
                matchesBadgeFilter(entry, effectiveFilter),
              );
              return (
                <Stack key={sectionKey} gap="xs">
                  <Group align="center">
                    <Text fw={700}>{detail.detailKey}</Text>
                  </Group>
                  <CombinedBadges
                    rankSummary={summarizeRanks(baseItems)}
                    statusSummary={summarizeStatuses(baseItems)}
                    filter={sectionFilter}
                    onFilterChange={(next) =>
                      setSectionFilter(sectionKey, next)
                    }
                  />
                  <Group
                    gap="sm"
                    align="stretch"
                    wrap="wrap"
                    style={{ width: "100%" }}
                  >
                    {visibleItems.map((entry) => (
                      <div
                        key={`${entry.music.id}-${entry.chartIndex}`}
                        style={{ cursor: "pointer" }}
                        onClick={() => handleScoreClick(entry)}
                      >
                        <MinimalMusicScoreCard
                          musicId={entry.music.id}
                          chartIndex={entry.chartIndex}
                          type={entry.music.type}
                          score={
                            entry.score?.score || entry.score?.dxScore || null
                          }
                          fs={entry.score?.fs ?? null}
                          fc={entry.score?.fc ?? null}
                          displaySettings={displayFilter}
                        />
                      </div>
                    ))}
                  </Group>
                  {idx < current.details.length - 1 && (
                    <Divider variant="dashed" mt="md" mb="0" />
                  )}
                </Stack>
              );
            })}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
