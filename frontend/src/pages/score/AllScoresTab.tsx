import {
  ActionIcon,
  Alert,
  Box,
  Checkbox,
  Divider,
  Group,
  Image,
  Loader,
  LoadingOverlay,
  MultiSelect,
  NumberInput,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronUp,
  IconSearch,
  IconSelector,
  IconX,
} from "@tabler/icons-react";
import { ScoreSummaryCard } from "../../components/ScoreSummaryBadges";
import {
  calculateAverageScore,
  summarizeRanks,
  summarizeStatuses,
} from "../../components/ScoreSummaryBadges.model";
import { getVersionSortIndex, sortVersions } from "../../constants/versions";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";

import type { SyncScore } from "../../types/syncScore";
import type { MusicChartPayload, MusicRow } from "../../types/music";
import { DeferredImage } from "../../components/DeferredImage";
import {
  getCoverUrl,
  getIconUrl,
  renderRank,
  type DetailedMusicScoreCardProps,
} from "../../components/MusicScoreCard";
import { ScoreDetailModal } from "../../components/ScoreDetailModal";
import {
  DesktopFilterCard,
  MobileFilterModalButton,
} from "../../components/ResponsiveFilterPanel";
import { useMusic } from "../../providers/MusicContext";
import {
  getRatingFloorByIsNew,
  getRatingFloors,
} from "../../utils/ratingFloors";

const FALLBACK_COVER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='100%25' height='100%25' fill='%23222931'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%238a8f98' font-size='10'>Cover</text></svg>";

// Difficulty colors matching MusicScoreCard
const LEVEL_COLORS: Record<number, string> = {
  0: "#6fe163", // Basic
  1: "#f8df3a", // Advanced
  2: "#fc4255", // Expert
  3: "#9a15ff", // Master
  4: "#dc9fff", // Re:Master
  10: "#ff69b4", // Utage
};

const DIFFICULTY_NAMES: Record<number, string> = {
  0: "Basic",
  1: "Advanced",
  2: "Expert",
  3: "Master",
  4: "Re:Master",
  10: "Utage",
};

type SortKey =
  | "title"
  | "level"
  | "detailLevel"
  | "score"
  | "dxScore"
  | "rating"
  | "rank"
  | "musicVersion";
type SortOrder = "asc" | "desc";

type AllScoresTabProps = {
  scores: SyncScore[];
  loading: boolean;
  error: string | null;
};

type ScoreFilterState = {
  categoryFilter: string[];
  versionFilter: string[];
  difficultyFilter: string[];
  designerFilter: string[];
  musicVersionFilter: string[];
  detailLevelMin: number | string;
  detailLevelMax: number | string;
};

type FilterOptions = {
  categories: string[];
  versions: string[];
  musicVersions: string[];
  difficulties: string[];
  designers: string[];
};

type ChartMap = Map<
  number,
  MusicChartPayload & { musicId: string; chartIndex: number }
>;

type ScoreComparatorContext = {
  musicMap: Map<string, MusicRow>;
  chartMap: ChartMap;
};

const RANK_ORDER: Record<string, number> = {
  "SSS+": 14,
  SSS: 13,
  "SS+": 12,
  SS: 11,
  "S+": 10,
  S: 9,
  AAA: 8,
  AA: 7,
  A: 6,
  BBB: 5,
  BB: 4,
  B: 3,
  C: 2,
  D: 1,
};

function getRank(scoreVal: number) {
  if (scoreVal >= 100.5) {return "SSS+";}
  if (scoreVal >= 100) {return "SSS";}
  if (scoreVal >= 99.5) {return "SS+";}
  if (scoreVal >= 99) {return "SS";}
  if (scoreVal >= 98) {return "S+";}
  if (scoreVal >= 97) {return "S";}
  if (scoreVal >= 94) {return "AAA";}
  if (scoreVal >= 90) {return "AA";}
  if (scoreVal >= 80) {return "A";}
  return "F";
}

function getScoreChart(
  score: SyncScore,
  chartMap: ChartMap,
) {
  return score.cid !== null && score.cid !== undefined
    ? chartMap.get(score.cid)
    : undefined;
}

function buildFilterOptions(
  scores: SyncScore[],
  musicMap: Map<string, MusicRow>,
  chartMap: ChartMap,
): FilterOptions {
  const categories = new Set<string>();
  const versions = new Set<string>();
  const musicVersions = new Set<string>();
  const designers = new Set<string>();

  scores.forEach((score) => {
    const music = musicMap.get(score.musicId);
    const chart = getScoreChart(score, chartMap);
    if (music?.category) {categories.add(music.category);}
    if (score.type) {versions.add(score.type.toUpperCase());}
    if (music?.version) {musicVersions.add(music.version);}
    if (chart?.charter) {designers.add(chart.charter);}
  });

  return {
    categories: Array.from(categories).sort(),
    versions: Array.from(versions).sort(),
    musicVersions: sortVersions(Array.from(musicVersions)),
    difficulties: Object.values(DIFFICULTY_NAMES),
    designers: Array.from(designers).sort(),
  };
}

function matchesDetailLevelFilter(
  detailLevel: number | null | undefined,
  filters: Pick<ScoreFilterState, "detailLevelMin" | "detailLevelMax">,
) {
  if (typeof detailLevel !== "number") {
    return true;
  }
  if (
    typeof filters.detailLevelMin === "number" &&
    detailLevel < filters.detailLevelMin
  ) {
    return false;
  }
  if (
    typeof filters.detailLevelMax === "number" &&
    detailLevel > filters.detailLevelMax
  ) {
    return false;
  }
  return true;
}

function scoreMatchesSearch(
  score: SyncScore,
  query: string,
  musicMap: Map<string, MusicRow>,
) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const music = musicMap.get(score.musicId);
  const title = (music?.title || "").toLowerCase();
  const musicId = (score.musicId || "").toLowerCase();
  return title.includes(normalized) || musicId.includes(normalized);
}

function scoreMatchesFilters(
  score: SyncScore,
  filters: ScoreFilterState,
  musicMap: Map<string, MusicRow>,
  chartMap: ChartMap,
) {
  const music = musicMap.get(score.musicId);
  const chart = getScoreChart(score, chartMap);
  const checks = [
    filters.categoryFilter.length === 0 ||
      filters.categoryFilter.includes(music?.category || ""),
    filters.versionFilter.length === 0 ||
      filters.versionFilter.includes(score.type?.toUpperCase?.() || ""),
    filters.difficultyFilter.length === 0 ||
      filters.difficultyFilter.includes(DIFFICULTY_NAMES[score.chartIndex] || ""),
    filters.designerFilter.length === 0 ||
      filters.designerFilter.includes(chart?.charter || ""),
    filters.musicVersionFilter.length === 0 ||
      filters.musicVersionFilter.includes(music?.version || ""),
    matchesDetailLevelFilter(chart?.detailLevel, filters),
  ];
  return checks.every(Boolean);
}

function parseScoreValue(value: string | null | undefined, fallback = -Infinity) {
  return value ? parseFloat(value.replace("%", "")) : fallback;
}

const SCORE_COMPARERS: Record<
  SortKey,
  (a: SyncScore, b: SyncScore, context: ScoreComparatorContext) => number
> = {
  title: (a, b, { musicMap }) =>
    (musicMap.get(a.musicId)?.title || a.musicId || "").localeCompare(
      musicMap.get(b.musicId)?.title || b.musicId || "",
      "zh-CN",
    ),
  level: (a, b) => (a.chartIndex ?? 0) - (b.chartIndex ?? 0),
  detailLevel: (a, b, { chartMap }) =>
    (getScoreChart(a, chartMap)?.detailLevel ?? 0) -
    (getScoreChart(b, chartMap)?.detailLevel ?? 0),
  score: (a, b) => parseScoreValue(a.score) - parseScoreValue(b.score),
  dxScore: (a, b) =>
    parseInt(a.dxScore ?? "", 10) - parseInt(b.dxScore ?? "", 10),
  rating: (a, b) =>
    (typeof a.rating === "number" ? a.rating : -Infinity) -
    (typeof b.rating === "number" ? b.rating : -Infinity),
  rank: (a, b) =>
    (RANK_ORDER[getRank(parseScoreValue(a.score, 0))] ?? 0) -
    (RANK_ORDER[getRank(parseScoreValue(b.score, 0))] ?? 0),
  musicVersion: (a, b, { musicMap }) =>
    getVersionSortIndex(musicMap.get(a.musicId)?.version || "") -
    getVersionSortIndex(musicMap.get(b.musicId)?.version || ""),
};

function compareScoresByKey(
  a: SyncScore,
  b: SyncScore,
  sortKey: SortKey,
  musicMap: Map<string, MusicRow>,
  chartMap: ChartMap,
) {
  return SCORE_COMPARERS[sortKey](a, b, { musicMap, chartMap });
}

function sortScores(
  scores: SyncScore[],
  sortKey: SortKey,
  sortOrder: SortOrder,
  musicMap: Map<string, MusicRow>,
  chartMap: ChartMap,
) {
  const sorted = [...scores];
  sorted.sort((a, b) => {
    const cmp = compareScoresByKey(a, b, sortKey, musicMap, chartMap);
    return sortOrder === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function SortableHeader({
  label,
  sortKey,
  currentSortKey,
  sortOrder,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  currentSortKey: SortKey;
  sortOrder: SortOrder;
  onSort: (key: SortKey) => void;
}) {
  const isActive = currentSortKey === sortKey;
  return (
    <Table.Th
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      onClick={() => onSort(sortKey)}
    >
      <Group gap={4} wrap="nowrap">
        <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
          {label}
        </Text>
        {isActive ? (
          sortOrder === "asc" ? (
            <IconChevronUp size={14} />
          ) : (
            <IconChevronDown size={14} />
          )
        ) : (
          <IconSelector size={14} style={{ opacity: 0.4 }} />
        )}
      </Group>
    </Table.Th>
  );
}

export function AllScoresTab({ scores, loading, error }: AllScoresTabProps) {
  const { musicMap, chartMap } = useMusic();
  const ratingFloors = useMemo(() => getRatingFloors(scores), [scores]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortKey, setSortKey] = useState<SortKey>("rating");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [isPending, startTransition] = useTransition();

  // Modal state
  const [modalOpened, setModalOpened] = useState(false);
  const [selectedScore, setSelectedScore] =
    useState<DetailedMusicScoreCardProps | null>(null);

  const handleScoreClick = (score: SyncScore) => {
    const music = musicMap.get(score.musicId);
    const chart =
      (score.cid !== null && score.cid !== undefined
        ? chartMap.get(score.cid)
        : undefined) ??
      music?.charts?.[score.chartIndex];
    setSelectedScore({
      musicId: score.musicId,
      chartIndex: score.chartIndex,
      type: score.type,
      rating: score.rating ?? null,
      score: score.score || null,
      fs: score.fs || null,
      fc: score.fc || null,
      dxScore: score.dxScore || null,
      chartPayload: chart || null,
      songMetadata: music
        ? {
            title: music.title,
            artist: music.artist,
            category: music.category,
            isNew: music.isNew,
            bpm: music.bpm,
            version: music.version,
          }
        : null,
      bpm:
        typeof music?.bpm === "number"
          ? music.bpm
          : parseInt(music?.bpm as string) || null,
      noteDesigner: chart?.charter || null,
      isNew: score.isNew ?? music?.isNew ?? null,
      ratingFloor: getRatingFloorByIsNew(
        score.isNew ?? music?.isNew,
        ratingFloors,
      ),
    });
    setModalOpened(true);
  };

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [versionFilter, setVersionFilter] = useState<string[]>([]);
  const [difficultyFilter, setDifficultyFilter] = useState<string[]>([]);
  const [designerFilter, setDesignerFilter] = useState<string[]>([]);
  const [musicVersionFilter, setMusicVersionFilter] = useState<string[]>([]);
  const [detailLevelMin, setDetailLevelMin] = useState<number | string>("");
  const [detailLevelMax, setDetailLevelMax] = useState<number | string>("");

  // Column visibility - all columns can be toggled
  const [showCover, setShowCover] = useState(true);
  const [showTitle, setShowTitle] = useState(true);
  const [showCategory, setShowCategory] = useState(false);
  const [showVersion, setShowVersion] = useState(false);
  const [showMusicVersion, setShowMusicVersion] = useState(false);
  const [showDifficulty, setShowDifficulty] = useState(true);
  const [showDetailLevel, setShowDetailLevel] = useState(true);
  const [showDesigner, setShowDesigner] = useState(false);
  const [showScore, setShowScore] = useState(true);
  const [showRank, setShowRank] = useState(true);
  const [showFc, setShowFc] = useState(true);
  const [showFs, setShowFs] = useState(true);
  const [showDxScore, setShowDxScore] = useState(false);
  const [showRating, setShowRating] = useState(true);

  // Ensure at least one column is visible
  const visibleColumns = [
    showCover,
    showTitle,
    showCategory,
    showVersion,
    showMusicVersion,
    showDifficulty,
    showDetailLevel,
    showDesigner,
    showScore,
    showRank,
    showFc,
    showFs,
    showDxScore,
    showRating,
  ].filter(Boolean).length;

  const canHideColumn = visibleColumns > 1;

  // Extract unique values for filters
  const filterOptions = useMemo(
    () => buildFilterOptions(scores, musicMap, chartMap),
    [scores, musicMap, chartMap],
  );

  // Filtered scores
  const filters: ScoreFilterState = useMemo(
    () => ({
      categoryFilter,
      versionFilter,
      difficultyFilter,
      designerFilter,
      musicVersionFilter,
      detailLevelMin,
      detailLevelMax,
    }),
    [
      categoryFilter,
      versionFilter,
      difficultyFilter,
      designerFilter,
      musicVersionFilter,
      detailLevelMin,
      detailLevelMax,
    ],
  );
  const filteredScores = useMemo(
    () =>
      scores.filter(
        (score) =>
          scoreMatchesSearch(score, searchQuery, musicMap) &&
          scoreMatchesFilters(score, filters, musicMap, chartMap),
      ),
    [scores, searchQuery, musicMap, chartMap, filters],
  );

  // Sorted scores
  const sortedScores = useMemo(
    () => sortScores(filteredScores, sortKey, sortOrder, musicMap, chartMap),
    [filteredScores, musicMap, chartMap, sortKey, sortOrder],
  );

  // Adjust page when filtered results change
  const validPage = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(sortedScores.length / pageSize));
    return page > totalPages ? totalPages : page;
  }, [sortedScores.length, page, pageSize]);

  // Sync page state when validPage differs
  useEffect(() => {
    if (validPage !== page) {
      setPage(validPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validPage]);

  const summary = useMemo(
    () => ({ total: sortedScores.length, page: validPage, pageSize }),
    [sortedScores.length, validPage, pageSize]
  );

  const paginatedScores = useMemo(() => {
    const start = (validPage - 1) * pageSize;
    return sortedScores.slice(start, start + pageSize);
  }, [sortedScores, validPage, pageSize]);

  // Convert filteredScores to format expected by summarize functions
  const scoreEntries = useMemo(
    () => filteredScores.map((s) => ({ score: s })),
    [filteredScores]
  );

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortOrder("desc");
      }
    },
    [sortKey]
  );

  const totalColumns =
    (showCover ? 1 : 0) +
    (showTitle ? 1 : 0) +
    (showCategory ? 1 : 0) +
    (showVersion ? 1 : 0) +
    (showMusicVersion ? 1 : 0) +
    (showDifficulty ? 1 : 0) +
    (showDetailLevel ? 1 : 0) +
    (showDesigner ? 1 : 0) +
    (showScore ? 1 : 0) +
    (showRank ? 1 : 0) +
    (showFc ? 1 : 0) +
    (showFs ? 1 : 0) +
    (showDxScore ? 1 : 0) +
    (showRating ? 1 : 0);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    categoryFilter.length > 0 ||
    versionFilter.length > 0 ||
    difficultyFilter.length > 0 ||
    designerFilter.length > 0 ||
    musicVersionFilter.length > 0 ||
    typeof detailLevelMin === "number" ||
    typeof detailLevelMax === "number";

  const clearAllFilters = () => {
    setSearchQuery("");
    setCategoryFilter([]);
    setVersionFilter([]);
    setDifficultyFilter([]);
    setDesignerFilter([]);
    setMusicVersionFilter([]);
    setDetailLevelMin("");
    setDetailLevelMax("");
  };

  const filterPanelContent = (
    <Stack gap="md">
      <Box>
        <Group justify="space-between" align="center" mb="xs">
          <Text size="xs" fw={600} c="dimmed">
            筛选条件
          </Text>
          {hasActiveFilters && (
            <Tooltip label="清除所有筛选">
              <ActionIcon variant="light" color="red" onClick={clearAllFilters}>
                <IconX size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 3, md: 4 }} spacing="sm">
          <MultiSelect
            label="分类"
            placeholder="全部"
            data={filterOptions.categories}
            value={categoryFilter}
            onChange={(value) =>
              startTransition(() => setCategoryFilter(value))
            }
            clearable
            searchable
            size="xs"
          />
          <MultiSelect
            label="铺面类型"
            placeholder="全部"
            data={filterOptions.versions}
            value={versionFilter}
            onChange={(value) =>
              startTransition(() => setVersionFilter(value))
            }
            clearable
            size="xs"
          />
          <MultiSelect
            label="难度"
            placeholder="全部"
            data={filterOptions.difficulties}
            value={difficultyFilter}
            onChange={(value) =>
              startTransition(() => setDifficultyFilter(value))
            }
            clearable
            size="xs"
          />
          <MultiSelect
            label="版本"
            placeholder="全部"
            data={filterOptions.musicVersions}
            value={musicVersionFilter}
            onChange={(value) =>
              startTransition(() => setMusicVersionFilter(value))
            }
            clearable
            searchable
            size="xs"
          />
          <MultiSelect
            label="谱师"
            placeholder="全部"
            data={filterOptions.designers}
            value={designerFilter}
            onChange={(value) =>
              startTransition(() => setDesignerFilter(value))
            }
            clearable
            searchable
            size="xs"
          />
          <Group gap="xs" align="flex-end">
            <NumberInput
              label="定数范围"
              placeholder="下限"
              value={detailLevelMin}
              onChange={(value) =>
                startTransition(() => setDetailLevelMin(value))
              }
              min={1}
              max={15}
              step={0.1}
              decimalScale={1}
              size="xs"
              style={{ flex: 1 }}
            />
            <Text size="xs" c="dimmed" pb={6}>
              -
            </Text>
            <NumberInput
              placeholder="上限"
              value={detailLevelMax}
              onChange={(value) =>
                startTransition(() => setDetailLevelMax(value))
              }
              min={1}
              max={15}
              step={0.1}
              decimalScale={1}
              size="xs"
              style={{ flex: 1 }}
            />
          </Group>
        </SimpleGrid>
      </Box>

      <Divider />

      <Box>
        <Text size="xs" fw={600} c="dimmed" mb="xs">
          显示列
        </Text>
        <SimpleGrid cols={{ base: 2, sm: 5, md: 7 }} spacing="xs">
          <Checkbox
            label="封面"
            size="xs"
            checked={showCover}
            onChange={(e) =>
              canHideColumn || !showCover
                ? setShowCover(e.currentTarget.checked)
                : null
            }
            disabled={showCover && !canHideColumn}
          />
          <Checkbox
            label="曲名"
            size="xs"
            checked={showTitle}
            onChange={(e) =>
              canHideColumn || !showTitle
                ? setShowTitle(e.currentTarget.checked)
                : null
            }
            disabled={showTitle && !canHideColumn}
          />
          <Checkbox
            label="分类"
            size="xs"
            checked={showCategory}
            onChange={(e) =>
              canHideColumn || !showCategory
                ? setShowCategory(e.currentTarget.checked)
                : null
            }
            disabled={showCategory && !canHideColumn}
          />
          <Checkbox
            label="铺面类型"
            size="xs"
            checked={showVersion}
            onChange={(e) =>
              canHideColumn || !showVersion
                ? setShowVersion(e.currentTarget.checked)
                : null
            }
            disabled={showVersion && !canHideColumn}
          />
          <Checkbox
            label="版本"
            size="xs"
            checked={showMusicVersion}
            onChange={(e) =>
              canHideColumn || !showMusicVersion
                ? setShowMusicVersion(e.currentTarget.checked)
                : null
            }
            disabled={showMusicVersion && !canHideColumn}
          />
          <Checkbox
            label="难度"
            size="xs"
            checked={showDifficulty}
            onChange={(e) =>
              canHideColumn || !showDifficulty
                ? setShowDifficulty(e.currentTarget.checked)
                : null
            }
            disabled={showDifficulty && !canHideColumn}
          />
          <Checkbox
            label="定数"
            size="xs"
            checked={showDetailLevel}
            onChange={(e) =>
              canHideColumn || !showDetailLevel
                ? setShowDetailLevel(e.currentTarget.checked)
                : null
            }
            disabled={showDetailLevel && !canHideColumn}
          />
          <Checkbox
            label="谱师"
            size="xs"
            checked={showDesigner}
            onChange={(e) =>
              canHideColumn || !showDesigner
                ? setShowDesigner(e.currentTarget.checked)
                : null
            }
            disabled={showDesigner && !canHideColumn}
          />
          <Checkbox
            label="达成率"
            size="xs"
            checked={showScore}
            onChange={(e) =>
              canHideColumn || !showScore
                ? setShowScore(e.currentTarget.checked)
                : null
            }
            disabled={showScore && !canHideColumn}
          />
          <Checkbox
            label="评级"
            size="xs"
            checked={showRank}
            onChange={(e) =>
              canHideColumn || !showRank
                ? setShowRank(e.currentTarget.checked)
                : null
            }
            disabled={showRank && !canHideColumn}
          />
          <Checkbox
            label="FC"
            size="xs"
            checked={showFc}
            onChange={(e) =>
              canHideColumn || !showFc
                ? setShowFc(e.currentTarget.checked)
                : null
            }
            disabled={showFc && !canHideColumn}
          />
          <Checkbox
            label="FS"
            size="xs"
            checked={showFs}
            onChange={(e) =>
              canHideColumn || !showFs
                ? setShowFs(e.currentTarget.checked)
                : null
            }
            disabled={showFs && !canHideColumn}
          />
          <Checkbox
            label="DX分数"
            size="xs"
            checked={showDxScore}
            onChange={(e) =>
              canHideColumn || !showDxScore
                ? setShowDxScore(e.currentTarget.checked)
                : null
            }
            disabled={showDxScore && !canHideColumn}
          />
          <Checkbox
            label="Rating"
            size="xs"
            checked={showRating}
            onChange={(e) =>
              canHideColumn || !showRating
                ? setShowRating(e.currentTarget.checked)
                : null
            }
            disabled={showRating && !canHideColumn}
          />
        </SimpleGrid>
      </Box>
    </Stack>
  );

  const searchInput = (
    <TextInput
      placeholder="搜索曲名"
      leftSection={<IconSearch size={16} />}
      value={searchQuery}
      onChange={(event) => setSearchQuery(event.currentTarget.value)}
      rightSection={
        searchQuery ? (
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="清除搜索"
            onClick={() => setSearchQuery("")}
          >
            <IconX size={14} />
          </ActionIcon>
        ) : null
      }
      size="sm"
    />
  );

  return (
    <Stack gap="md">
      <ScoreDetailModal
        opened={modalOpened}
        onClose={() => setModalOpened(false)}
        scoreData={selectedScore}
      />
      {error && (
        <Alert
          color="red"
          icon={<IconAlertCircle size={18} />}
          title="拉取失败"
          variant="light"
        >
          {error}
        </Alert>
      )}

      <Group justify="space-between" align="center" gap="sm">
        <Group gap="sm" align="baseline">
          <Title order={4} size="h5">
            全部成绩
          </Title>
          <Text size="sm">
            共 {scores.length} 条记录
            {filteredScores.length !== scores.length && (
              <> (筛选后: {filteredScores.length})</>
            )}
          </Text>
        </Group>
        <MobileFilterModalButton active={hasActiveFilters}>
          {filterPanelContent}
        </MobileFilterModalButton>
      </Group>

      {/* Mobile: search stays outside the filter modal */}
      <Box hiddenFrom="sm">{searchInput}</Box>

      <DesktopFilterCard>
        <Stack gap="md">
          {filterPanelContent}
          <Divider />
          {searchInput}
        </Stack>
      </DesktopFilterCard>

      {/* Score Summary */}
      {filteredScores.length > 0 && (
        <ScoreSummaryCard
          rankSummary={summarizeRanks(scoreEntries)}
          statusSummary={summarizeStatuses(scoreEntries)}
          averageScore={calculateAverageScore(scoreEntries)}
        />
      )}

      <Box pos="relative" mih={200}>
        <LoadingOverlay
          visible={isPending}
          zIndex={10}
          overlayProps={{ radius: "sm", blur: 2 }}
        />
        <Box style={{ overflowX: "auto", maxWidth: "100%" }}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                {showCover && <Table.Th>封面</Table.Th>}
                {showTitle && (
                  <SortableHeader
                    label="曲名"
                    sortKey="title"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
                {showCategory && <Table.Th>分类</Table.Th>}
                {showVersion && <Table.Th>铺面类型</Table.Th>}
                {showMusicVersion && (
                  <SortableHeader
                    label="铺面版本"
                    sortKey="musicVersion"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
                {showDifficulty && (
                  <SortableHeader
                    label="难度"
                    sortKey="level"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
                {showDetailLevel && (
                  <SortableHeader
                    label="定数"
                    sortKey="detailLevel"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
                {showDesigner && <Table.Th>谱师</Table.Th>}
                {showScore && (
                  <SortableHeader
                    label="达成率"
                    sortKey="score"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
                {showRank && (
                  <SortableHeader
                    label="评级"
                    sortKey="rank"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
                {showFc && <Table.Th>FC</Table.Th>}
                {showFs && <Table.Th>FS</Table.Th>}
                {showDxScore && (
                  <SortableHeader
                    label="DX分数"
                    sortKey="dxScore"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
                {showRating && (
                  <SortableHeader
                    label="Rating"
                    sortKey="rating"
                    currentSortKey={sortKey}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {paginatedScores.map((score, idx) => {
                const music = musicMap.get(score.musicId);
                const chart =
                  score.cid !== null && score.cid !== undefined
                    ? chartMap.get(score.cid)
                    : undefined;
                if (!chart) {
                  console.log("Missing chart for score:", score);
                }
                const name = music?.title || score.musicId;
                const artist = music?.artist;
                const coverUrl = getCoverUrl(score.musicId);
                const level = chart?.level || "-";
                const detailLevel =
                  typeof chart?.detailLevel === "number"
                    ? chart.detailLevel.toFixed(1)
                    : "-";
                const scoreValue = score.score ?? "-";
                const safeScore = score.score
                  ? parseFloat(score.score.replace("%", ""))
                  : null;
                const rank =
                  safeScore !== null && !Number.isNaN(safeScore)
                    ? getRank(safeScore)
                    : null;
                const ratingValue =
                  typeof score.rating === "number"
                    ? Math.round(score.rating)
                    : "-";
                const difficultyColor =
                  LEVEL_COLORS[score.chartIndex] || "#888";
                const difficultyName =
                  DIFFICULTY_NAMES[score.chartIndex] || "Unknown";

                return (
                  <Table.Tr
                    key={`${score.musicId}-${score.chartIndex}-${score.cid}-${idx}`}
                    style={{
                      backgroundColor: `${difficultyColor}30`,
                      cursor: "pointer",
                    }}
                    onClick={() => handleScoreClick(score)}
                  >
                    {/* 封面 */}
                    {showCover && (
                      <Table.Td style={{ padding: 4 }}>
                        <DeferredImage
                          src={coverUrl}
                          alt={name}
                          h={48}
                          w={48}
                          fit="cover"
                          radius="sm"
                          fallbackSrc={FALLBACK_COVER}
                        />
                      </Table.Td>
                    )}

                    {/* 曲名 + Artist */}
                    {showTitle && (
                      <Table.Td>
                        <Stack gap={0}>
                          <Text fw={600} size="sm" lineClamp={1} title={name}>
                            {name}
                          </Text>
                          {artist && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {artist}
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                    )}

                    {/* 分类 */}
                    {showCategory && (
                      <Table.Td>
                        <Text size="xs">{music?.category || "-"}</Text>
                      </Table.Td>
                    )}

                    {/* 铺面类型 */}
                    {showVersion && (
                      <Table.Td>
                        <Text size="xs" fw={600}>
                          {score.type?.toUpperCase?.() || "-"}
                        </Text>
                      </Table.Td>
                    )}

                    {/* 铺面版本 */}
                    {showMusicVersion && (
                      <Table.Td>
                        <Text size="xs">{music?.version || "-"}</Text>
                      </Table.Td>
                    )}

                    {/* 难度 */}
                    {showDifficulty && (
                      <Table.Td>
                        <Box
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 4,
                            backgroundColor: difficultyColor,
                            color: "white",
                            fontWeight: 600,
                            fontSize: 12,
                          }}
                        >
                          {difficultyName}
                        </Box>
                      </Table.Td>
                    )}

                    {/* 定数 */}
                    {showDetailLevel && (
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <Text size="sm" fw={600}>
                            {level}
                          </Text>
                          <Text size="xs" c="dimmed">
                            ({detailLevel})
                          </Text>
                        </Group>
                      </Table.Td>
                    )}

                    {/* 谱师 */}
                    {showDesigner && (
                      <Table.Td>
                        <Text size="xs" lineClamp={1}>
                          {chart?.charter || "-"}
                        </Text>
                      </Table.Td>
                    )}

                    {/* 达成率 */}
                    {showScore && (
                      <Table.Td>
                        <Text
                          fw={700}
                          size="sm"
                          // c="#f5d142"
                          // style={{
                          //   textShadow:
                          //     "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000",
                          // }}
                        >
                          {scoreValue}
                        </Text>
                      </Table.Td>
                    )}

                    {/* 评级 */}
                    {showRank && (
                      <Table.Td>
                        {rank && (
                          <Text fw={700} size="sm">
                            {renderRank(rank, { compact: true, stroke: true })}
                          </Text>
                        )}
                      </Table.Td>
                    )}

                    {/* FC */}
                    {showFc && (
                      <Table.Td style={{ padding: 4 }}>
                        {score.fc ? (
                          <Image
                            src={getIconUrl(score.fc)}
                            w={24}
                            h={24}
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <Box
                            w={20}
                            h={20}
                            style={{
                              borderRadius: "50%",
                              backgroundColor: "white",
                              border: "1px solid #ccc",
                            }}
                          />
                        )}
                      </Table.Td>
                    )}

                    {/* FS */}
                    {showFs && (
                      <Table.Td style={{ padding: 4 }}>
                        {score.fs ? (
                          <Image
                            src={getIconUrl(score.fs)}
                            w={24}
                            h={24}
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <Box
                            w={20}
                            h={20}
                            style={{
                              borderRadius: "50%",
                              backgroundColor: "white",
                              border: "1px solid #ccc",
                            }}
                          />
                        )}
                      </Table.Td>
                    )}

                    {/* DX分数 */}
                    {showDxScore && (
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {score.dxScore || "-"}
                        </Text>
                      </Table.Td>
                    )}

                    {/* Rating */}
                    {showRating && (
                      <Table.Td>
                        <Text fw={700} size="sm">
                          {ratingValue}
                        </Text>
                      </Table.Td>
                    )}
                  </Table.Tr>
                );
              })}
              {sortedScores.length === 0 && !loading && (
                <Table.Tr>
                  <Table.Td colSpan={totalColumns}>
                    <Text c="dimmed" ta="center">
                      暂无成绩数据。
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {loading && (
                <Table.Tr>
                  <Table.Td colSpan={totalColumns}>
                    <Group justify="center" py="md">
                      <Loader size="sm" />
                      <Text c="dimmed">加载中...</Text>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>

          <Group justify="space-between" px="md" py="sm" align="center">
            <Text size="sm" c="dimmed">
              {summary.total > 0 ? (page - 1) * pageSize + 1 : 0} -
              {Math.min(page * pageSize, summary.total)} / {summary.total}
            </Text>
            <Group gap="sm" align="center">
              <Pagination
                total={Math.max(1, Math.ceil(summary.total / pageSize))}
                value={page}
                onChange={setPage}
                size="sm"
                radius="md"
                disabled={loading || summary.total === 0}
              />
              <Text size="sm" c="dimmed">
                每页
              </Text>
              <Select
                size="xs"
                value={String(pageSize)}
                onChange={(value) => {
                  const next = Number(value ?? "20");
                  setPageSize(next);
                  setPage(1);
                }}
                data={[
                  { value: "10", label: "10" },
                  { value: "20", label: "20" },
                  { value: "50", label: "50" },
                  { value: "100", label: "100" },
                ]}
                styles={{ input: { width: 72 } }}
              />
            </Group>
          </Group>
        </Box>
      </Box>
    </Stack>
  );
}
