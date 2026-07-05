import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Image,
  Modal,
  NumberFormatter,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconCategory,
  IconClock,
  IconHash,
  IconUser,
  IconVersions,
  IconX,
} from "@tabler/icons-react";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMediaQuery } from "@mantine/hooks";

import {
  DIFFICULTY_NAMES,
  LEVEL_COLORS,
  getCoverUrl,
  getIconUrl,
  getRank,
  parseScore,
  type DetailedMusicScoreCardProps,
} from "./MusicScoreCard";
import classes from "./ScoreDetailModal.module.css";

export interface ScoreDetailModalProps {
  opened: boolean;
  onClose: () => void;
  scoreData: DetailedMusicScoreCardProps | null;
}

type NoteKey = "tap" | "hold" | "slide" | "touch" | "break";
type CalculatorMode = "0+" | "100-" | "101-";
type JudgementKey = "perfect" | "great" | "good" | "miss";

type NoteStats = {
  counts: Record<NoteKey, number | null>;
  total: number | null;
  hasBreakdown: boolean;
  sides?: Array<{ label: string; total: number | null }>;
};

const FALLBACK_COVER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><rect width='100%25' height='100%25' fill='%23222931'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%238a8f98' font-size='12'>Cover</text></svg>";
const ASSET_BASE = "/mai/pic";

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

const NOTE_ROWS: Array<{
  key: NoteKey;
  label: string;
  weight: number;
  color: string;
}> = [
  { key: "tap", label: "TAP", weight: 1, color: "blue" },
  { key: "hold", label: "HOLD", weight: 2, color: "green" },
  { key: "slide", label: "SLIDE", weight: 3, color: "grape" },
  { key: "touch", label: "TOUCH", weight: 1, color: "cyan" },
  { key: "break", label: "BREAK", weight: 5, color: "orange" },
];

const BASIC_WEIGHTS = {
  perfect: {
    tap: 1,
    hold: 2,
    slide: 3,
    touch: 1,
    break: 5,
  },
  great: {
    tap: 0.8,
    hold: 1.6,
    slide: 2.4,
    touch: 0.8,
    break: [4, 3, 2.5],
  },
  good: {
    tap: 0.5,
    hold: 1,
    slide: 1.5,
    touch: 0.5,
    break: 2,
  },
  miss: {
    tap: 0,
    hold: 0,
    slide: 0,
    touch: 0,
    break: 0,
  },
} as const;

const BREAK_BONUS = {
  criticalPerfect: 1,
  perfect: [0.75, 0.5],
  great: 0.4,
  good: 0.3,
  miss: 0,
} as const;

function emptyCounts(): Record<NoteKey, number | null> {
  return {
    tap: null,
    hold: null,
    slide: null,
    touch: null,
    break: null,
  };
}

function toFiniteNumber(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/,/g, ""))
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function sumNumericValues(values: unknown[]) {
  let total = 0;
  let found = false;
  for (const value of values) {
    const n = toFiniteNumber(value);
    if (n !== null) {
      total += n;
      found = true;
    }
  }
  return found ? total : null;
}

function getNotesTotal(notes: unknown): number | null {
  if (Array.isArray(notes)) {
    return sumNumericValues(notes);
  }
  if (!notes || typeof notes !== "object") {
    return null;
  }

  const record = notes as Record<string, unknown>;
  const total = toFiniteNumber(record.total);
  if (total !== null) {
    return total;
  }
  if (record.notes !== undefined) {
    const nested = getNotesTotal(record.notes);
    if (nested !== null) {
      return nested;
    }
  }

  return sumNumericValues(NOTE_ROWS.map((row) => record[row.key]));
}

function getNoteStats(notes: unknown): NoteStats {
  const counts = emptyCounts();

  if (Array.isArray(notes)) {
    NOTE_ROWS.forEach((row, index) => {
      counts[row.key] = toFiniteNumber(notes[index]);
    });
    const total = sumNumericValues(NOTE_ROWS.map((row) => counts[row.key]));
    return {
      counts,
      total,
      hasBreakdown: Object.values(counts).some((value) => value !== null),
    };
  }

  if (!notes || typeof notes !== "object") {
    return { counts, total: null, hasBreakdown: false };
  }

  const record = notes as Record<string, unknown>;

  if (record.left !== undefined || record.right !== undefined) {
    const left = getNoteStats(record.left);
    const right = getNoteStats(record.right);
    const sides = [
      { label: "1P 谱面", total: left.total },
      { label: "2P 谱面", total: right.total },
    ].filter((side) => side.total !== null);

    for (const row of NOTE_ROWS) {
      const value = sumNumericValues([left.counts[row.key], right.counts[row.key]]);
      counts[row.key] = value;
    }

    const totalFromSides = sumNumericValues([left.total, right.total]);
    return {
      counts,
      total: totalFromSides ?? getNotesTotal(notes),
      hasBreakdown: Object.values(counts).some((value) => value !== null),
      sides: sides.length > 0 ? sides : undefined,
    };
  }

  if (record.notes !== undefined) {
    const nested = getNoteStats(record.notes);
    if (nested.hasBreakdown || nested.total !== null) {
      return nested;
    }
  }

  for (const row of NOTE_ROWS) {
    counts[row.key] = toFiniteNumber(record[row.key]);
  }

  const total =
    toFiniteNumber(record.total) ??
    sumNumericValues(NOTE_ROWS.map((row) => counts[row.key]));

  return {
    counts,
    total,
    hasBreakdown: Object.values(counts).some((value) => value !== null),
  };
}

function getNoteSources(notes: unknown) {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    return [{ value: "main", label: "谱面", stats: getNoteStats(notes) }];
  }

  const record = notes as Record<string, unknown>;
  if (record.left === undefined && record.right === undefined) {
    return [{ value: "main", label: "谱面", stats: getNoteStats(notes) }];
  }

  const sources: Array<{ value: string; label: string; stats: NoteStats }> = [];
  if (record.left !== undefined) {
    sources.push({
      value: "left",
      label: "1P 谱面",
      stats: getNoteStats(record.left),
    });
  }
  if (record.right !== undefined) {
    sources.push({
      value: "right",
      label: "2P 谱面",
      stats: getNoteStats(record.right),
    });
  }

  const totalStats = getNoteStats(notes);
  if (totalStats.hasBreakdown || totalStats.total !== null) {
    sources.push({ value: "total", label: "合计", stats: totalStats });
  }

  return sources.length > 0
    ? sources
    : [{ value: "main", label: "谱面", stats: totalStats }];
}

function getAchievementWeightTotal(noteStats: NoteStats) {
  if (!noteStats.hasBreakdown) return null;
  const total = NOTE_ROWS.reduce(
    (sum, row) => sum + (noteStats.counts[row.key] ?? 0) * row.weight,
    0,
  );
  return total > 0 ? total : null;
}

function formatPercent(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(4)}%` : "-";
}

function PercentageLines({
  values,
}: {
  values: Array<{ value: number; highlight?: boolean }>;
}) {
  return (
    <Stack gap={1}>
      {values.map((item, index) => (
        <Text
          key={`${item.value}:${index}`}
          size="sm"
          lh={1.25}
          c={item.highlight ? "yellow" : undefined}
        >
          {formatPercent(item.value)}
        </Text>
      ))}
    </Stack>
  );
}

function getCalculatorCell(
  noteKey: NoteKey,
  judgement: JudgementKey,
  noteStats: NoteStats,
  achievementWeightTotal: number | null,
  mode: CalculatorMode,
) {
  const count = noteStats.counts[noteKey] ?? 0;
  const breakCount = noteStats.counts.break ?? 0;
  if (count <= 0 || achievementWeightTotal === null) return "-";

  if (noteKey === "break" && breakCount <= 0) return "-";

  if (noteKey === "break" && judgement === "perfect") {
    const criticalPerfectBonus = BREAK_BONUS.criticalPerfect / breakCount;

    if (mode === "100-") {
      return (
        <PercentageLines
          values={[
            { value: criticalPerfectBonus, highlight: true },
            { value: BREAK_BONUS.perfect[0] / breakCount },
            {
              value:
                criticalPerfectBonus - BREAK_BONUS.perfect[1] / breakCount,
            },
          ]}
        />
      );
    }

    if (mode === "101-") {
      return (
        <PercentageLines
          values={[
            { value: 0, highlight: true },
            {
              value:
                BREAK_BONUS.perfect[0] / breakCount - criticalPerfectBonus,
            },
            {
              value:
                BREAK_BONUS.perfect[1] / breakCount - criticalPerfectBonus,
            },
          ]}
        />
      );
    }

    const percentage =
      (BASIC_WEIGHTS.perfect.break / achievementWeightTotal) * 100;
    return (
      <PercentageLines
        values={[
          { value: percentage + criticalPerfectBonus, highlight: true },
          { value: percentage + BREAK_BONUS.perfect[0] / breakCount },
          { value: percentage + BREAK_BONUS.perfect[1] / breakCount },
        ]}
      />
    );
  }

  if (noteKey === "break" && judgement === "great") {
    return (
      <PercentageLines
        values={BASIC_WEIGHTS.great.break.map((weight) => {
          let percentage =
            (weight / achievementWeightTotal) * 100 +
            BREAK_BONUS.great / breakCount;

          if (mode === "100-" || mode === "101-") {
            let perfectBreak =
              (BASIC_WEIGHTS.perfect.break / achievementWeightTotal) * 100;
            if (mode === "101-") {
              perfectBreak += BREAK_BONUS.criticalPerfect / breakCount;
            }
            percentage -= perfectBreak;
          }

          return { value: percentage };
        })}
      />
    );
  }

  const rawWeight = BASIC_WEIGHTS[judgement][noteKey];
  let weight = typeof rawWeight === "number" ? rawWeight : 0;
  let bonus: number | readonly number[] = BREAK_BONUS[judgement];

  if (mode === "100-" || mode === "101-") {
    if (judgement === "perfect") {
      weight = BASIC_WEIGHTS.miss[noteKey];
    } else if (judgement === "great") {
      weight =
        BASIC_WEIGHTS.perfect[noteKey] -
        (BASIC_WEIGHTS.great[noteKey] as number);
    } else if (judgement === "good") {
      weight = BASIC_WEIGHTS.perfect[noteKey] - BASIC_WEIGHTS.good[noteKey];
      bonus =
        mode === "101-"
          ? BREAK_BONUS.criticalPerfect - BREAK_BONUS.good
          : BREAK_BONUS.miss - BREAK_BONUS.good;
    } else if (judgement === "miss") {
      weight = BASIC_WEIGHTS.perfect[noteKey];
      bonus = mode === "101-" ? BREAK_BONUS.criticalPerfect : BREAK_BONUS.miss;
    }
  }

  let percentage = (weight / achievementWeightTotal) * 100;
  if (noteKey === "break" && typeof bonus === "number") {
    percentage += bonus / breakCount;
  }
  if (mode === "100-" || mode === "101-") {
    percentage = -percentage;
  }

  return formatPercent(percentage);
}

function parseAchievement(value: string | null) {
  const parsed = parseScore(value);
  if (parsed === null || parsed > 101.5) return null;
  return parsed;
}

function formatAchievement(value: string | null) {
  const parsed = parseAchievement(value);
  if (parsed === null) return value || "N/A";
  return `${parsed.toFixed(4)}%`;
}

function formatTypeLabel(type: string) {
  if (type === "standard") return "标准";
  if (type === "dx") return "DX";
  if (type === "utage") return "宴";
  return type.toUpperCase();
}

function getDetailLevelText(scoreData: DetailedMusicScoreCardProps) {
  const detailLevel = scoreData.chartPayload?.detailLevel;
  if (typeof detailLevel === "number") return detailLevel.toFixed(1);
  return detailLevel ?? scoreData.chartPayload?.level ?? "?";
}

function getBpmDisplay(scoreData: DetailedMusicScoreCardProps) {
  return scoreData.bpm ?? scoreData.songMetadata?.bpm ?? null;
}

function parseDxScore(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function getDxStar(dxPercent: number) {
  if (dxPercent <= 85) return 0;
  if (dxPercent <= 90) return 1;
  if (dxPercent <= 93) return 2;
  if (dxPercent <= 95) return 3;
  if (dxPercent <= 97) return 4;
  return 5;
}

function MetadataItem({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  const tooltipLabel =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;

  return (
    <Box className={classes.metadataItem}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <ThemeIcon size="sm" variant="light" color="gray">
          {icon}
        </ThemeIcon>
        <Stack gap={1} className={classes.fieldText}>
          <Text size="xs" c="dimmed">
            {label}
          </Text>
          <Tooltip
            label={tooltipLabel}
            disabled={!tooltipLabel}
            openDelay={250}
            withinPortal
          >
          <Text size="sm" fw={400} className={classes.fieldValue}>
            {value}
          </Text>
          </Tooltip>
        </Stack>
      </Group>
    </Box>
  );
}

function ScoreStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <Paper className={classes.statTile} withBorder>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={400} className={classes.statValue}>
        {value}
      </Text>
      {detail ? (
        <Text size="xs" c="dimmed" className={classes.statDetail}>
          {detail}
        </Text>
      ) : null}
    </Paper>
  );
}

function ScoreSummary({
  scoreData,
  maxDxScore,
}: {
  scoreData: DetailedMusicScoreCardProps;
  maxDxScore: number | null;
}) {
  const songInfoRef = useRef<HTMLDivElement | null>(null);
  const [coverSize, setCoverSize] = useState<number | null>(null);
  const difficultyColor = LEVEL_COLORS[scoreData.chartIndex] || "#888";
  const difficultyName =
    DIFFICULTY_NAMES[scoreData.chartIndex]?.toUpperCase() || "UNKNOWN";
  const detailLevelText = getDetailLevelText(scoreData);
  const levelText = scoreData.chartPayload?.level ?? detailLevelText;
  const achievement = parseAchievement(scoreData.score);
  const rank = achievement !== null ? getRank(achievement) : null;
  const rankAsset = rank ? RANK_ASSET[rank] : null;
  const dxScore = parseDxScore(scoreData.dxScore);
  const bpm = getBpmDisplay(scoreData);
  const metadataItems: Array<{
    label: string;
    value: ReactNode | null | undefined;
    icon: ReactNode;
  }> = [
    {
      label: "谱师",
      value: scoreData.noteDesigner ?? scoreData.chartPayload?.charter,
      icon: <IconUser size={14} />,
    },
    {
      label: "BPM",
      value: bpm,
      icon: <IconClock size={14} />,
    },
    {
      label: "分类",
      value: scoreData.songMetadata?.category,
      icon: <IconCategory size={14} />,
    },
    {
      label: "版本",
      value: scoreData.songMetadata?.version,
      icon: <IconVersions size={14} />,
    },
  ];
  const visibleMetadataItems = metadataItems.filter(
    (
      item,
    ): item is {
      label: string;
      value: ReactNode;
      icon: ReactNode;
    } => item.value !== null && item.value !== undefined && item.value !== "",
  );
  const dxPercent =
    dxScore !== null && maxDxScore !== null && maxDxScore > 0
      ? (dxScore / maxDxScore) * 100
      : null;
  const dxStar = dxPercent !== null ? getDxStar(dxPercent) : null;

  useLayoutEffect(() => {
    const element = songInfoRef.current;
    if (!element) return;

    const updateSize = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      if (height > 0) {
        setCoverSize((current) => (current === height ? current : height));
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scoreData.musicId, scoreData.chartIndex]);

  return (
    <Box
      className={classes.summary}
      style={{ "--difficulty-color": difficultyColor } as CSSProperties}
    >
      <Group wrap="nowrap" align="flex-start" className={classes.summaryHeader}>
        <Box
          className={classes.coverFrame}
          style={
            coverSize
              ? { width: coverSize, height: coverSize }
              : undefined
          }
        >
          <Image
            src={getCoverUrl(scoreData.musicId)}
            fallbackSrc={FALLBACK_COVER}
            alt={scoreData.songMetadata?.title || scoreData.musicId}
            className={classes.cover}
          />
        </Box>
        <Stack gap="xs" className={classes.songInfo} ref={songInfoRef}>
          <Group gap={6}>
            <Badge variant="filled" color={scoreData.type === "dx" ? "orange" : "blue"}>
              {formatTypeLabel(scoreData.type)}
            </Badge>
            {scoreData.songMetadata?.isNew ? (
              <Badge variant="light" color="teal">
                新曲 / B15
              </Badge>
            ) : null}
            <Badge
              variant="light"
              color="gray"
              leftSection={<IconHash size={12} />}
            >
              {scoreData.musicId}
            </Badge>
          </Group>
          <Stack gap={2}>
            <Title order={3} className={classes.songTitle}>
              {scoreData.songMetadata?.title || "Unknown Title"}
            </Title>
            {scoreData.songMetadata?.artist ? (
              <Text size="sm" c="dimmed" lineClamp={1}>
                {scoreData.songMetadata.artist}
              </Text>
            ) : null}
          </Stack>
          <Group gap="xs">
            <Badge
              className={classes.levelBadge}
              style={{ "--difficulty-color": difficultyColor } as CSSProperties}
            >
              {difficultyName}
            </Badge>
            <Badge variant="default">{levelText}</Badge>
            {detailLevelText !== levelText ? (
              <Badge variant="light" color="gray">
                定数 {detailLevelText}
              </Badge>
            ) : null}
          </Group>
        </Stack>
      </Group>

      <Group className={classes.achievementRow} align="center" gap="sm" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" className={classes.achievementMain}>
          {rankAsset ? (
            <Image
              src={`${ASSET_BASE}/${rankAsset}`}
              alt={rank ?? "评级"}
              className={classes.rankImage}
            />
          ) : null}
          <Text fw={400} className={classes.achievementText}>
            {formatAchievement(scoreData.score)}
          </Text>
        </Group>
        <Group gap={0} wrap="nowrap" className={classes.statusGroup}>
          <Box className={classes.statusIcon}>
            {scoreData.fc ? (
              <Image src={getIconUrl(scoreData.fc)} w={32} h={32} />
            ) : null}
          </Box>
          <Box className={classes.statusIcon}>
            {scoreData.fs ? (
              <Image src={getIconUrl(scoreData.fs)} w={32} h={32} />
            ) : null}
          </Box>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, xs: 2 }} spacing="sm">
        <ScoreStat
          label="DX Rating"
          value={
            typeof scoreData.rating === "number"
              ? Math.round(scoreData.rating)
              : "-"
          }
        />
        <ScoreStat
          label="DX 分数"
          value={
            dxScore !== null ? (
              <Group gap="xs" wrap="nowrap" className={classes.dxScoreLine}>
                <Text span inherit>
                  <NumberFormatter value={dxScore} thousandSeparator />
                  {maxDxScore !== null ? (
                    <>
                      {" "}
                      / <NumberFormatter value={maxDxScore} thousandSeparator />
                    </>
                  ) : null}
                </Text>
                {dxStar !== null && dxStar > 0 ? (
                  <Image
                    src={`${ASSET_BASE}/UI_GAM_Gauge_DXScoreIcon_0${dxStar}.png`}
                    alt={`${dxStar} 星`}
                    className={classes.dxStarIcon}
                  />
                ) : null}
              </Group>
            ) : (
              "N/A"
            )
          }
        />
      </SimpleGrid>

      {visibleMetadataItems.length > 0 ? (
        <SimpleGrid cols={{ base: 2, xs: 4 }} spacing="xs">
          {visibleMetadataItems.map((item) => (
            <MetadataItem
              key={item.label}
              icon={item.icon}
              label={item.label}
              value={item.value}
            />
          ))}
        </SimpleGrid>
      ) : null}
    </Box>
  );
}

function ChartDetails({
  scoreData,
  noteStats,
  maxDxScore,
}: {
  scoreData: DetailedMusicScoreCardProps;
  noteStats: NoteStats;
  maxDxScore: number | null;
}) {
  const [calculatorMode, setCalculatorMode] =
    useState<CalculatorMode>("101-");
  const [noteSourceValue, setNoteSourceValue] = useState("main");
  const noteSources = useMemo(
    () => getNoteSources(scoreData.chartPayload?.notes),
    [scoreData.chartPayload?.notes],
  );
  const currentNoteSource =
    noteSources.find((source) => source.value === noteSourceValue) ??
    noteSources[0] ?? { value: "main", label: "谱面", stats: noteStats };
  const activeNoteStats = currentNoteSource.stats;
  const achievementWeightTotal = getAchievementWeightTotal(activeNoteStats);
  const noteRows = NOTE_ROWS.filter(
    (row) => activeNoteStats.counts[row.key] !== null,
  );
  const calculatorRows = [
    {
      key: "total",
      label: "TOTAL",
      count: activeNoteStats.total,
      color: "gray",
    },
    ...noteRows.map((row) => ({
      key: row.key,
      label: row.label,
      count: activeNoteStats.counts[row.key],
      color: row.color,
    })),
  ];

  return (
    <Stack gap="md" className={classes.chartDetails}>
      <Stack gap="sm">
        <Group justify="space-between" align="center" gap="xs">
          <Text fw={700}>谱面详细</Text>
          {activeNoteStats.total !== null ? (
            <Badge variant="light" color="gray">
              总物量{" "}
              <NumberFormatter value={activeNoteStats.total} thousandSeparator />
            </Badge>
          ) : null}
        </Group>

        <Group className={classes.calculatorControls} gap="xs" align="center">
          {noteSources.length > 1 ? (
            <SegmentedControl
              size="xs"
              value={currentNoteSource.value}
              onChange={setNoteSourceValue}
              data={noteSources.map((source) => ({
                value: source.value,
                label: source.label,
              }))}
            />
          ) : null}
          <Select
            size="xs"
            w={96}
            value={calculatorMode}
            onChange={(value) =>
              setCalculatorMode((value ?? "101-") as CalculatorMode)
            }
            data={[
              { value: "0+", label: "0+" },
              { value: "100-", label: "100-" },
              { value: "101-", label: "101-" },
            ]}
            allowDeselect={false}
            comboboxProps={{ shadow: "md" }}
          />
          <Text size="xs" c="dimmed">
            {calculatorMode === "0+"
              ? "绝对达成率"
              : `距离 ${calculatorMode.replace("-", "%")} 的损失`}
          </Text>
        </Group>

        {activeNoteStats.hasBreakdown ? (
          <Box className={classes.calculatorTableWrap}>
            <Table
              className={classes.calculatorTable}
              striped
              highlightOnHover
              withTableBorder
              horizontalSpacing="xs"
              layout="fixed"
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Note</Table.Th>
                  <Table.Th>物量</Table.Th>
                  <Table.Th c="orange">PERFECT</Table.Th>
                  <Table.Th c="pink">GREAT</Table.Th>
                  <Table.Th c="green">GOOD</Table.Th>
                  <Table.Th c="gray">MISS</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {calculatorRows.map((row) => (
                  <Table.Tr key={`${calculatorMode}:${row.key}`}>
                    <Table.Td>
                      <Badge variant="light" color={row.color}>
                        {row.label}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {row.count !== null ? (
                        <NumberFormatter value={row.count} thousandSeparator />
                      ) : (
                        "-"
                      )}
                    </Table.Td>
                    {row.key === "total" || row.count === 0 ? (
                      <>
                        <Table.Td>-</Table.Td>
                        <Table.Td>-</Table.Td>
                        <Table.Td>-</Table.Td>
                        <Table.Td>-</Table.Td>
                      </>
                    ) : (
                      (["perfect", "great", "good", "miss"] as const).map(
                        (judgement) => (
                          <Table.Td key={judgement}>
                            {getCalculatorCell(
                              row.key as NoteKey,
                              judgement,
                              activeNoteStats,
                              achievementWeightTotal,
                              calculatorMode,
                            )}
                          </Table.Td>
                        ),
                      )
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        ) : (
          <Paper withBorder className={classes.emptyChartData}>
            <Text size="sm" c="dimmed">
              当前曲库没有返回该谱面的物量数据。
            </Text>
          </Paper>
        )}

        <Group gap="xs">
          <Badge variant="default">DX 上限</Badge>
          {activeNoteStats.total !== null ? (
            <Text size="sm">
              <NumberFormatter value={activeNoteStats.total * 3} thousandSeparator />
            </Text>
          ) : (
            <Text size="sm" c="dimmed">
              -
            </Text>
          )}
          {maxDxScore !== null &&
          activeNoteStats.total !== null &&
          maxDxScore !== activeNoteStats.total * 3 ? (
            <Text size="xs" c="dimmed">
              当前详情合计上限{" "}
              <NumberFormatter value={maxDxScore} thousandSeparator />
            </Text>
          ) : null}
        </Group>
      </Stack>
    </Stack>
  );
}

export function ScoreDetailModal({
  opened,
  onClose,
  scoreData,
}: ScoreDetailModalProps) {
  const fullScreen = useMediaQuery("(max-width: 48em)");
  const noteStats = useMemo(
    () => getNoteStats(scoreData?.chartPayload?.notes),
    [scoreData?.chartPayload?.notes],
  );
  const noteTotal = noteStats.total ?? getNotesTotal(scoreData?.chartPayload?.notes);
  const maxDxScore =
    scoreData?.maxDxScore ??
    (noteTotal !== null && noteTotal > 0 ? noteTotal * 3 : null);

  return (
    <Modal.Root
      opened={opened}
      onClose={onClose}
      fullScreen={fullScreen}
      centered={!fullScreen}
      lockScroll={false}
      size="lg"
      classNames={{
        inner: classes.modalInner,
        content: classes.modalContent,
        header: classes.modalHeader,
        body: classes.modalBody,
      }}
      transitionProps={{
        transition: fullScreen ? "slide-up" : "fade-down",
        duration: 180,
      }}
    >
      <Modal.Overlay
        backgroundOpacity={fullScreen ? 0 : 0.55}
        blur={fullScreen ? 0 : 3}
      />
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>
            <Text fw={700}>成绩详情</Text>
          </Modal.Title>
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={onClose}
            aria-label="关闭"
          >
            <IconX size={18} />
          </ActionIcon>
        </Modal.Header>
        <Modal.Body>
          {scoreData ? (
            <>
              <ScoreSummary
                scoreData={scoreData}
                maxDxScore={maxDxScore}
              />
              <ChartDetails
                scoreData={scoreData}
                noteStats={noteStats}
                maxDxScore={maxDxScore}
              />
            </>
          ) : null}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
