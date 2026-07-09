import {
  ActionIcon,
  Badge,
  Box,
  Collapse,
  Group,
  Modal,
  NumberFormatter,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Switch,
} from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useMediaQuery } from "@mantine/hooks";

import {
  type DetailedMusicScoreCardProps,
} from "./MusicScoreCard";
import { ScoreRatingCalculatorSection } from "./ScoreRatingCalculatorSection";
import {
  ScoreSummary,
  ScoreVerificationSection,
} from "./ScoreDetailSummary";
import {
  ScoreDetailBudgetTable,
  TARGET_ACHIEVEMENT_OPTIONS,
} from "./ScoreDetailBudgetTable";
import classes from "./ScoreDetailModal.module.css";

export interface ScoreDetailModalProps {
  opened: boolean;
  onClose: () => void;
  scoreData: DetailedMusicScoreCardProps | null;
}

type NoteKey = "tap" | "hold" | "slide" | "touch" | "break";
type CalculatorMode = "0+" | "100-" | "101-";
type CalculatorTableMode = "budget" | "legacy";
type JudgementKey = "perfect" | "great" | "good" | "miss";

type NoteStats = {
  counts: Record<NoteKey, number | null>;
  total: number | null;
  hasBreakdown: boolean;
  sides?: Array<{ label: string; total: number | null }>;
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

const NOTE_ARRAY_ROWS_DX: NoteKey[] = ["tap", "hold", "slide", "touch", "break"];
const NOTE_ARRAY_ROWS_SD: NoteKey[] = ["tap", "hold", "slide", "break"];

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
    const rows = notes.length >= 5 ? NOTE_ARRAY_ROWS_DX : NOTE_ARRAY_ROWS_SD;
    rows.forEach((key, index) => {
      counts[key] = toFiniteNumber(notes[index]);
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
  if (!noteStats.hasBreakdown) {return null;}
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

function getBreakPerfectCell(
  breakCount: number,
  achievementWeightTotal: number,
  mode: CalculatorMode,
) {
  const criticalPerfectBonus = BREAK_BONUS.criticalPerfect / breakCount;

  if (mode === "100-") {
    return (
      <PercentageLines
        values={[
          { value: criticalPerfectBonus, highlight: true },
          { value: BREAK_BONUS.perfect[0] / breakCount },
          { value: criticalPerfectBonus - BREAK_BONUS.perfect[1] / breakCount },
        ]}
      />
    );
  }

  if (mode === "101-") {
    return (
      <PercentageLines
        values={[
          { value: 0, highlight: true },
          { value: BREAK_BONUS.perfect[0] / breakCount - criticalPerfectBonus },
          { value: BREAK_BONUS.perfect[1] / breakCount - criticalPerfectBonus },
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

function getBreakGreatCell(
  breakCount: number,
  achievementWeightTotal: number,
  mode: CalculatorMode,
) {
  const perfectBase =
    (BASIC_WEIGHTS.perfect.break / achievementWeightTotal) * 100;
  const criticalBonus =
    mode === "101-" ? BREAK_BONUS.criticalPerfect / breakCount : 0;
  const subtractPerfect = mode === "100-" || mode === "101-";

  return (
    <PercentageLines
      values={BASIC_WEIGHTS.great.break.map((weight) => {
        const breakGreat =
          (weight / achievementWeightTotal) * 100 +
          BREAK_BONUS.great / breakCount;
        return {
          value: subtractPerfect
            ? breakGreat - perfectBase - criticalBonus
            : breakGreat,
        };
      })}
    />
  );
}

function getAdjustedCalculatorWeight(
  noteKey: NoteKey,
  judgement: JudgementKey,
  mode: CalculatorMode,
) {
  const rawWeight = BASIC_WEIGHTS[judgement][noteKey];
  const base = {
    weight: typeof rawWeight === "number" ? rawWeight : 0,
    bonus: BREAK_BONUS[judgement] as number | readonly number[],
  };

  if (mode === "0+") {
    return base;
  }

  switch (judgement) {
    case "perfect":
      return { weight: BASIC_WEIGHTS.miss[noteKey], bonus: base.bonus };
    case "great":
      return {
        weight:
          BASIC_WEIGHTS.perfect[noteKey] -
          (BASIC_WEIGHTS.great[noteKey] as number),
        bonus: base.bonus,
      };
    case "good":
      return {
        weight: BASIC_WEIGHTS.perfect[noteKey] - BASIC_WEIGHTS.good[noteKey],
        bonus:
          mode === "101-"
            ? BREAK_BONUS.criticalPerfect - BREAK_BONUS.good
            : BREAK_BONUS.miss - BREAK_BONUS.good,
      };
    case "miss":
      return {
        weight: BASIC_WEIGHTS.perfect[noteKey],
        bonus: mode === "101-" ? BREAK_BONUS.criticalPerfect : BREAK_BONUS.miss,
      };
  }
}

function getGenericCalculatorCell(
  noteKey: NoteKey,
  judgement: JudgementKey,
  breakCount: number,
  achievementWeightTotal: number,
  mode: CalculatorMode,
) {
  const { weight, bonus } = getAdjustedCalculatorWeight(
    noteKey,
    judgement,
    mode,
  );
  let percentage = (weight / achievementWeightTotal) * 100;
  if (noteKey === "break" && typeof bonus === "number") {
    percentage += bonus / breakCount;
  }
  if (mode === "100-" || mode === "101-") {
    percentage = -percentage;
  }

  return formatPercent(percentage);
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
  if (count <= 0 || achievementWeightTotal === null) {
    return "-";
  }
  if (noteKey === "break" && breakCount <= 0) {
    return "-";
  }
  if (noteKey === "break" && judgement === "perfect") {
    return getBreakPerfectCell(breakCount, achievementWeightTotal, mode);
  }
  if (noteKey === "break" && judgement === "great") {
    return getBreakGreatCell(breakCount, achievementWeightTotal, mode);
  }

  return getGenericCalculatorCell(
    noteKey,
    judgement,
    breakCount,
    achievementWeightTotal,
    mode,
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
  const [opened, setOpened] = useState(false);
  const [calculatorTableMode, setCalculatorTableMode] =
    useState<CalculatorTableMode>("budget");
  const [calculatorMode, setCalculatorMode] =
    useState<CalculatorMode>("101-");
  const [targetAchievement, setTargetAchievement] = useState("100.5");
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
      <Group justify="space-between" align="center" gap="xs">
        <Group gap="xs">
          <Text fw={700}>谱面详细</Text>
          {activeNoteStats.total !== null ? (
            <Badge variant="light" color="gray">
              总物量{" "}
              <NumberFormatter value={activeNoteStats.total} thousandSeparator />
            </Badge>
          ) : null}
        </Group>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={opened ? "收起谱面详细" : "展开谱面详细"}
          onClick={() => setOpened((value) => !value)}
        >
          {opened ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </ActionIcon>
      </Group>

      <Collapse in={opened}>
        <Stack gap="sm">
        <Group className={classes.calculatorControls} gap="xs" align="center" wrap="wrap">
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
          <Group gap="xs" align="center" wrap="nowrap">
            <Switch
              size="xs"
              checked={calculatorTableMode === "budget"}
              onChange={(event) =>
                setCalculatorTableMode(
                  event.currentTarget.checked ? "budget" : "legacy",
                )
              }
              onLabel="新"
              offLabel="旧"
              label={calculatorTableMode === "budget" ? "目标容错" : "旧表格"}
            />
            {calculatorTableMode === "budget" ? (
              <Select
                size="xs"
                w={112}
                value={targetAchievement}
                onChange={(value) => setTargetAchievement(value ?? "100.5")}
                data={TARGET_ACHIEVEMENT_OPTIONS}
                allowDeselect={false}
                comboboxProps={{ shadow: "md" }}
                aria-label="目标达成率"
              />
            ) : (
              <>
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
              </>
            )}
          </Group>
        </Group>

        {activeNoteStats.hasBreakdown ? (
          calculatorTableMode === "budget" ? (
            <ScoreDetailBudgetTable
              noteStats={activeNoteStats}
              achievementWeightTotal={achievementWeightTotal}
              targetAchievement={Number(targetAchievement)}
            />
          ) : (
            <Box className={classes.calculatorTableWrap}>
              <Table
                className={classes.calculatorTable}
                striped
                highlightOnHover
                withTableBorder
                withColumnBorders
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
          )
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
      </Collapse>
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
              <ScoreVerificationSection scoreData={scoreData} />
              <ScoreRatingCalculatorSection scoreData={scoreData} />
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
