import {
  Box,
  NumberFormatter,
  Paper,
  Stack,
  Table,
  Text,
} from "@mantine/core";

import classes from "./ScoreDetailModal.module.css";

type NoteKey = "tap" | "hold" | "slide" | "touch" | "break";
type NonBreakNoteKey = Exclude<NoteKey, "break">;
type JudgementKey = "perfect" | "great" | "good" | "miss";

type NoteStats = {
  counts: Record<NoteKey, number | null>;
  total: number | null;
  hasBreakdown: boolean;
  sides?: Array<{ label: string; total: number | null }>;
};

type EquivalentCellValue = {
  label?: string;
  equivalent: number;
};

type BreakEquivalentGroup = {
  judgement: JudgementKey;
  label: string;
  values: EquivalentCellValue[];
};

const NOTE_ROWS: Array<{
  key: NoteKey;
  label: string;
  color: string;
}> = [
  { key: "tap", label: "TAP", color: "blue" },
  { key: "touch", label: "TOUCH", color: "cyan" },
  { key: "hold", label: "HOLD", color: "green" },
  { key: "slide", label: "SLIDE", color: "grape" },
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

export const TARGET_ACHIEVEMENT_OPTIONS = [
  "100.5",
  "100",
  "99.5",
  "99",
  "98",
  "97",
].map((value) => ({
  value,
  label: `${value}%`,
}));

function formatPercent(value: number) {
  return Number.isFinite(value) ? `${value.toFixed(4)}%` : "-";
}

function formatEquivalent(value: number) {
  return Number.isFinite(value)
    ? value.toFixed(2).replace(/\.?0+$/, "")
    : "-";
}

function getTargetBudget(targetAchievement: number) {
  return Math.max(0, 101 - targetAchievement);
}

function getTapGreatLoss(achievementWeightTotal: number) {
  return ((BASIC_WEIGHTS.perfect.tap - BASIC_WEIGHTS.great.tap) /
    achievementWeightTotal) * 100;
}

function getNonBreakLoss(
  noteKey: NonBreakNoteKey,
  judgement: "perfect" | "great" | "good" | "miss",
  achievementWeightTotal: number,
) {
  if (judgement === "perfect") {
    return 0;
  }

  return (
    ((BASIC_WEIGHTS.perfect[noteKey] - BASIC_WEIGHTS[judgement][noteKey]) /
      achievementWeightTotal) *
    100
  );
}

function getBreakLoss(
  judgement: JudgementKey,
  achievementWeightTotal: number,
  breakCount: number,
) {
  if (judgement === "perfect") {
    return BREAK_BONUS.perfect.map((bonus, index) => ({
      label: index === 0 ? "2550" : "2500",
      equivalent:
        (BREAK_BONUS.criticalPerfect - bonus) /
        breakCount /
        getTapGreatLoss(achievementWeightTotal),
    }));
  }

  if (judgement === "great") {
    return BASIC_WEIGHTS.great.break.map((weight, index) => ({
      label: ["2000", "1500", "1250"][index],
      equivalent:
        (((BASIC_WEIGHTS.perfect.break - weight) / achievementWeightTotal) *
          100 +
          (BREAK_BONUS.criticalPerfect - BREAK_BONUS.great) / breakCount) /
        getTapGreatLoss(achievementWeightTotal),
    }));
  }

  const weight = BASIC_WEIGHTS[judgement].break;
  const bonus = BREAK_BONUS[judgement];
  return [
    {
      label: judgement === "good" ? "1000" : "0",
      equivalent:
        (((BASIC_WEIGHTS.perfect.break - weight) / achievementWeightTotal) *
          100 +
          (BREAK_BONUS.criticalPerfect - bonus) / breakCount) /
        getTapGreatLoss(achievementWeightTotal),
    },
  ];
}

function getJudgementClassName(judgement: JudgementKey) {
  switch (judgement) {
    case "perfect":
      return classes.judgementPerfect;
    case "great":
      return classes.judgementGreat;
    case "good":
      return classes.judgementGood;
    case "miss":
      return classes.judgementMiss;
  }
}

function renderEquivalentValue(value: number, judgement: JudgementKey) {
  return (
    <Text
      component="span"
      size="sm"
      lh={1.25}
      className={getJudgementClassName(judgement)}
    >
      {formatEquivalent(value)}
    </Text>
  );
}

function renderEquivalentCell(
  values: EquivalentCellValue[],
  judgement: JudgementKey,
) {
  return (
    <Stack gap={3}>
      {values.map((item, index) => (
        <Box
          key={`${item.label ?? ""}:${item.equivalent}:${index}`}
          className={item.label ? classes.equivalentCellLine : undefined}
        >
          {item.label ? (
            <Text size="sm" fw={700} c="orange" component="span">
              {item.label}
            </Text>
          ) : null}
          {renderEquivalentValue(item.equivalent, judgement)}
        </Box>
      ))}
    </Stack>
  );
}

function getBreakEquivalentGroups(
  achievementWeightTotal: number,
  breakCount: number,
): BreakEquivalentGroup[] {
  return [
    {
      judgement: "perfect",
      label: "Perfect",
      values: getBreakLoss("perfect", achievementWeightTotal, breakCount),
    },
    {
      judgement: "great",
      label: "Great",
      values: getBreakLoss("great", achievementWeightTotal, breakCount),
    },
    {
      judgement: "good",
      label: "Good",
      values: getBreakLoss("good", achievementWeightTotal, breakCount),
    },
    {
      judgement: "miss",
      label: "Miss",
      values: getBreakLoss("miss", achievementWeightTotal, breakCount),
    },
  ];
}

function getCellValues(
  noteKey: NoteKey,
  judgement: JudgementKey,
  achievementWeightTotal: number,
  breakCount: number,
) {
  if (noteKey === "break") {
    return breakCount > 0
      ? getBreakLoss(judgement, achievementWeightTotal, breakCount)
      : [];
  }

  const loss = getNonBreakLoss(noteKey, judgement, achievementWeightTotal);
  return [
    {
      equivalent: loss / getTapGreatLoss(achievementWeightTotal),
    },
  ];
}

export function ScoreDetailBudgetTable({
  noteStats,
  achievementWeightTotal,
  targetAchievement,
}: {
  noteStats: NoteStats;
  achievementWeightTotal: number | null;
  targetAchievement: number;
}) {
  if (achievementWeightTotal === null) {
    return (
      <Paper withBorder className={classes.emptyChartData}>
        <Text size="sm" c="dimmed">
          当前曲库没有返回可用于达成率容错计算的物量数据。
        </Text>
      </Paper>
    );
  }

  const targetBudget = getTargetBudget(targetAchievement);
  const tapGreatLoss = getTapGreatLoss(achievementWeightTotal);
  const maxTapGreat = Math.min(
    noteStats.counts.tap ?? 0,
    Math.floor((targetBudget + 1e-9) / tapGreatLoss),
  );
  const breakCount = noteStats.counts.break ?? 0;
  const visibleRows = NOTE_ROWS.filter((row) => {
    const count = noteStats.counts[row.key];
    return count !== null && count > 0;
  });
  const breakGroups =
    breakCount > 0
      ? getBreakEquivalentGroups(achievementWeightTotal, breakCount)
      : [];

  return (
    <Stack gap="xs">
      <Box className={classes.budgetSummaryGrid}>
        <Paper withBorder className={classes.budgetMetric}>
          <Text size="xs" c="dimmed">
            目标预算
          </Text>
          <Text fw={700} className={classes.budgetMetricValue}>
            {formatPercent(targetBudget)}
          </Text>
        </Paper>
        <Paper withBorder className={classes.budgetMetric}>
          <Text size="xs" c="dimmed">
            TAP 粉损失
          </Text>
          <Text fw={700} className={classes.budgetMetricValue}>
            {formatPercent(tapGreatLoss)}
          </Text>
        </Paper>
        <Paper withBorder className={classes.budgetMetric}>
          <Text size="xs" c="dimmed">
            最多 TAP 粉
          </Text>
          <Text fw={700} className={classes.budgetMetricValue}>
            <NumberFormatter value={maxTapGreat} thousandSeparator />
          </Text>
        </Paper>
      </Box>

      <Box className={classes.calculatorTableWrap}>
        <Table
          className={`${classes.calculatorTable} ${classes.budgetTable} ${classes.equivalentTable}`}
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
              <Table.Th className={classes.judgementGreat}>Great</Table.Th>
              <Table.Th className={classes.judgementGood}>Good</Table.Th>
              <Table.Th className={classes.judgementMiss}>Miss</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visibleRows.map((row) => (
              <Table.Tr key={`${targetAchievement}:${row.key}`}>
                <Table.Td>
                  <Text size="sm" fw={700} c={row.color}>
                    {row.label}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <NumberFormatter
                    value={noteStats.counts[row.key] ?? 0}
                    thousandSeparator
                  />
                </Table.Td>
                {(
                  [
                    "great",
                    "good",
                    "miss",
                  ] as const
                ).map((judgement) => (
                  <Table.Td key={`${row.key}:${judgement}`}>
                    {renderEquivalentCell(
                      getCellValues(
                        row.key,
                        judgement,
                        achievementWeightTotal,
                        breakCount,
                      ),
                      judgement,
                    )}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>

      {breakCount > 0 ? (
        <Paper withBorder className={classes.breakEquivalentPanel}>
          <Box className={classes.breakEquivalentHeader}>
            <Text size="sm" fw={700} c="orange">
              BREAK
            </Text>
            <Text size="xs" c="dimmed">
              <NumberFormatter value={breakCount} thousandSeparator />
            </Text>
          </Box>
          <Stack gap={6}>
            {breakGroups.map((group) => (
              <Box
                key={group.judgement}
                className={classes.breakEquivalentRow}
              >
                <Text
                  size="sm"
                  fw={700}
                  className={`${classes.breakEquivalentJudgement} ${getJudgementClassName(group.judgement)}`}
                >
                  {group.label}
                </Text>
                <Box className={classes.breakEquivalentGrid}>
                  {group.values.map((item) => (
                    <Box
                      key={`${group.judgement}:${item.label ?? ""}:${item.equivalent}`}
                      className={classes.breakEquivalentItem}
                    >
                      <Text
                        size="sm"
                        fw={700}
                        c="orange"
                        className={classes.equivalentScoreText}
                      >
                        {item.label}
                      </Text>
                      <Text
                        size="sm"
                        fw={600}
                        lh={1.2}
                        className={getJudgementClassName(group.judgement)}
                      >
                        {formatEquivalent(item.equivalent)}
                      </Text>
                    </Box>
                  ))}
                </Box>
              </Box>
            ))}
          </Stack>
        </Paper>
      ) : null}

      <Text size="xs" c="dimmed">
        表内数值表示等效多少个 TAP 粉；BREAK 单独按 2550 / 2500 /
        2000 / 1500 / 1250 / 1000 / 0 展示。
      </Text>
    </Stack>
  );
}
