import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Image,
  Loader,
  MultiSelect,
  NumberInput,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronUp,
  IconFilter,
  IconSelector,
  IconX,
} from "@tabler/icons-react";
import type { SyncScore } from "../../types/syncScore";
import { renderRank } from "../../components/MusicScoreCard";
import { useMusic } from "../../providers/MusicProvider";
import {
  calculateAverageScore,
  ScoreSummaryCard,
  summarizeRanks,
  summarizeStatuses,
} from "../../components/ScoreSummaryBadges";

const FALLBACK_COVER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='100%25' height='100%25' fill='%23222931'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%238a8f98' font-size='10'>Cover</text></svg>";

// Difficulty colors matching MusicScoreCard
const LEVEL_COLORS: Record<number, string> = {
  0: "#6fe163", // Basic
  1: "#f8df3a", // Advanced
  2: "#fc4255", // Expert
  3: "#9a15ff", // Master
  4: "#dc9fff", // Re:Master
};

const DIFFICULTY_NAMES: Record<number, string> = {
  0: "Basic",
  1: "Advanced",
  2: "Expert",
  3: "Master",
  4: "Re:Master",
};

type SortKey =
  | "title"
  | "level"
  | "detailLevel"
  | "score"
  | "dxScore"
  | "rating";
type SortOrder = "asc" | "desc";

type AllScoresTabProps = {
  scores: SyncScore[];
  loading: boolean;
  error: string | null;
};

function getRank(scoreVal: number) {
  if (scoreVal >= 100.5) return "SSS+";
  if (scoreVal >= 100) return "SSS";
  if (scoreVal >= 99.5) return "SS+";
  if (scoreVal >= 99) return "SS";
  if (scoreVal >= 98) return "S+";
  if (scoreVal >= 97) return "S";
  if (scoreVal >= 94) return "AAA";
  if (scoreVal >= 90) return "AA";
  if (scoreVal >= 80) return "A";
  return "F";
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
      style={{ cursor: "pointer", userSelect: "none" }}
      onClick={() => onSort(sortKey)}
    >
      <Group gap={4} wrap="nowrap">
        <Text size="sm" fw={600}>
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortKey, setSortKey] = useState<SortKey>("rating");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [filterOpen, setFilterOpen] = useState(false);

  // Filters
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
  const filterOptions = useMemo(() => {
    const categories = new Set<string>();
    const versions = new Set<string>();
    const musicVersions = new Set<string>();
    const designers = new Set<string>();

    scores.forEach((s) => {
      const music = musicMap.get(s.musicId);
      const chart = chartMap.get(`${s.musicId}:${s.chartIndex}`);
      if (music?.category) categories.add(music.category);
      if (s.type) versions.add(s.type.toUpperCase());
      if (music?.version) musicVersions.add(music.version);
      if (chart?.charter) designers.add(chart.charter);
    });

    return {
      categories: Array.from(categories).sort(),
      versions: Array.from(versions).sort(),
      musicVersions: Array.from(musicVersions).sort(),
      difficulties: Object.values(DIFFICULTY_NAMES),
      designers: Array.from(designers).sort(),
    };
  }, [scores, musicMap, chartMap]);

  // Filtered scores
  const filteredScores = useMemo(() => {
    return scores.filter((s) => {
      const music = musicMap.get(s.musicId);
      const chart = chartMap.get(`${s.musicId}:${s.chartIndex}`);
      if (
        categoryFilter.length > 0 &&
        !categoryFilter.includes(music?.category || "")
      )
        return false;
      if (
        versionFilter.length > 0 &&
        !versionFilter.includes(s.type?.toUpperCase?.() || "")
      )
        return false;
      if (difficultyFilter.length > 0) {
        const diffName = DIFFICULTY_NAMES[s.chartIndex];
        if (!diffName || !difficultyFilter.includes(diffName)) return false;
      }
      if (
        designerFilter.length > 0 &&
        !designerFilter.includes(chart?.charter || "")
      )
        return false;
      if (
        musicVersionFilter.length > 0 &&
        !musicVersionFilter.includes(music?.version || "")
      )
        return false;
      // Detail level range filter
      const detailLevel = chart?.detailLevel;
      if (typeof detailLevel === "number") {
        if (typeof detailLevelMin === "number" && detailLevel < detailLevelMin)
          return false;
        if (typeof detailLevelMax === "number" && detailLevel > detailLevelMax)
          return false;
      }
      return true;
    });
  }, [
    scores,
    musicMap,
    chartMap,
    categoryFilter,
    versionFilter,
    difficultyFilter,
    designerFilter,
    musicVersionFilter,
    detailLevelMin,
    detailLevelMax,
  ]);

  // Sorted scores
  const sortedScores = useMemo(() => {
    const sorted = [...filteredScores];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "title": {
          const musicA = musicMap.get(a.musicId);
          const musicB = musicMap.get(b.musicId);
          const titleA = musicA?.title || a.musicId || "";
          const titleB = musicB?.title || b.musicId || "";
          cmp = titleA.localeCompare(titleB, "zh-CN");
          break;
        }
        case "level": {
          cmp = (a.chartIndex ?? 0) - (b.chartIndex ?? 0);
          break;
        }
        case "detailLevel": {
          const chartA = chartMap.get(`${a.musicId}:${a.chartIndex}`);
          const chartB = chartMap.get(`${b.musicId}:${b.chartIndex}`);
          const lvA =
            typeof chartA?.detailLevel === "number" ? chartA.detailLevel : 0;
          const lvB =
            typeof chartB?.detailLevel === "number" ? chartB.detailLevel : 0;
          cmp = lvA - lvB;
          break;
        }
        case "score": {
          const scoreA = a.score
            ? parseFloat(a.score.replace("%", ""))
            : -Infinity;
          const scoreB = b.score
            ? parseFloat(b.score.replace("%", ""))
            : -Infinity;
          cmp = scoreA - scoreB;
          break;
        }
        case "dxScore": {
          const dxA = a.dxScore ? parseInt(a.dxScore, 10) : -Infinity;
          const dxB = b.dxScore ? parseInt(b.dxScore, 10) : -Infinity;
          cmp = dxA - dxB;
          break;
        }
        case "rating": {
          const ratingA = typeof a.rating === "number" ? a.rating : -Infinity;
          const ratingB = typeof b.rating === "number" ? b.rating : -Infinity;
          cmp = ratingA - ratingB;
          break;
        }
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filteredScores, musicMap, chartMap, sortKey, sortOrder]);

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
    categoryFilter.length > 0 ||
    versionFilter.length > 0 ||
    difficultyFilter.length > 0 ||
    designerFilter.length > 0 ||
    musicVersionFilter.length > 0 ||
    typeof detailLevelMin === "number" ||
    typeof detailLevelMax === "number";

  const clearAllFilters = () => {
    setCategoryFilter([]);
    setVersionFilter([]);
    setDifficultyFilter([]);
    setDesignerFilter([]);
    setMusicVersionFilter([]);
    setDetailLevelMin("");
    setDetailLevelMax("");
  };

  return (
    <Stack gap="md">
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

      <Group gap={8} align="center">
        <Title order={4} size="h5">
          全部成绩
        </Title>
      </Group>

      {/* Filter Header */}
      <Group>
        <Group gap="xs">
          <Button
            variant={filterOpen ? "filled" : "light"}
            size="xs"
            leftSection={<IconFilter size={16} />}
            onClick={() => setFilterOpen((v) => !v)}
          >
            筛选
            {hasActiveFilters && ` (${filteredScores.length})`}
          </Button>
          {hasActiveFilters && (
            <Tooltip label="清除所有筛选">
              <ActionIcon variant="light" color="red" onClick={clearAllFilters}>
                <IconX size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <Group gap="sm">
          <Text size="sm">
            共 {scores.length} 条记录
            {filteredScores.length !== scores.length && (
              <> (筛选后: {filteredScores.length})</>
            )}
          </Text>
        </Group>
      </Group>

      {/* Filter Panel */}
      <Collapse in={filterOpen}>
        <Card shadow="none" radius="md" p="md" withBorder>
          <Stack gap="md">
            {/* Filters */}
            <Box>
              <Text size="xs" fw={600} c="dimmed" mb="xs">
                筛选条件
              </Text>
              <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="sm">
                <MultiSelect
                  label="分类"
                  placeholder="全部"
                  data={filterOptions.categories}
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                  clearable
                  searchable
                  size="xs"
                />
                <MultiSelect
                  label="铺面类型"
                  placeholder="全部"
                  data={filterOptions.versions}
                  value={versionFilter}
                  onChange={setVersionFilter}
                  clearable
                  size="xs"
                />
                <MultiSelect
                  label="难度"
                  placeholder="全部"
                  data={filterOptions.difficulties}
                  value={difficultyFilter}
                  onChange={setDifficultyFilter}
                  clearable
                  size="xs"
                />
                <MultiSelect
                  label="版本"
                  placeholder="全部"
                  data={filterOptions.musicVersions}
                  value={musicVersionFilter}
                  onChange={setMusicVersionFilter}
                  clearable
                  searchable
                  size="xs"
                />
                <MultiSelect
                  label="谱师"
                  placeholder="全部"
                  data={filterOptions.designers}
                  value={designerFilter}
                  onChange={setDesignerFilter}
                  clearable
                  searchable
                  size="xs"
                />
                <Group gap="xs" align="flex-end">
                  <NumberInput
                    label="定数范围"
                    placeholder="下限"
                    value={detailLevelMin}
                    onChange={setDetailLevelMin}
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
                    onChange={setDetailLevelMax}
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

            {/* Column Visibility */}
            <Box>
              <Text size="xs" fw={600} c="dimmed" mb="xs">
                显示列
              </Text>
              <SimpleGrid cols={{ base: 3, sm: 5, md: 7 }} spacing="xs">
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
        </Card>
      </Collapse>

      {/* Score Summary */}
      {filteredScores.length > 0 && (
        <ScoreSummaryCard
          rankSummary={summarizeRanks(scoreEntries)}
          statusSummary={summarizeStatuses(scoreEntries)}
          averageScore={calculateAverageScore(scoreEntries)}
        />
      )}

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
              {showMusicVersion && <Table.Th>铺面版本</Table.Th>}
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
              {showRank && <Table.Th>评级</Table.Th>}
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
              const chart = chartMap.get(
                `${score.musicId}:${score.chartIndex}`
              );
              const name = music?.title || score.musicId;
              const artist = music?.artist;
              const coverUrl = `/api/cover/${score.musicId}`;
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
              const difficultyColor = LEVEL_COLORS[score.chartIndex] || "#888";
              const difficultyName =
                DIFFICULTY_NAMES[score.chartIndex] || "Unknown";

              return (
                <Table.Tr
                  key={`${score.musicId}-${score.chartIndex}-${score.cid}-${idx}`}
                  style={{
                    backgroundColor: `${difficultyColor}30`,
                  }}
                >
                  {/* 封面 */}
                  {showCover && (
                    <Table.Td style={{ padding: 4 }}>
                      <Image
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
                          src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${score.fc}.png`}
                          w={24}
                          h={24}
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
                          src={`https://maimai.wahlap.com/maimai-mobile/img/music_icon_${score.fs}.png`}
                          w={24}
                          h={24}
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
    </Stack>
  );
}
