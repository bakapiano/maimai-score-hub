import {
  ActionIcon,
  Group,
  NumberInput,
  Popover,
  SegmentedControl,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { IconAdjustments } from "@tabler/icons-react";
import { useState } from "react";

export type ScoreDisplayMode = "rank" | "score";

export type DisplayFilterSettings = {
  showFc: boolean;
  showFs: boolean;
  showScore: boolean;
  scoreDisplayMode: ScoreDisplayMode;
  scoreDecimals: number;
  scoreMin: number | null;
  scoreMax: number | null;
};

export const DEFAULT_DISPLAY_FILTER: DisplayFilterSettings = {
  showFc: true,
  showFs: true,
  showScore: true,
  scoreDisplayMode: "rank",
  scoreDecimals: 2,
  scoreMin: null,
  scoreMax: null,
};

type ScoreDisplayFilterProps = {
  value: DisplayFilterSettings;
  onChange: (value: DisplayFilterSettings) => void;
};

export function ScoreDisplayFilter({ value, onChange }: ScoreDisplayFilterProps) {
  const [opened, setOpened] = useState(false);

  const update = (patch: Partial<DisplayFilterSettings>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
      withArrow
    >
      <Popover.Target>
        <ActionIcon
          variant="default"
          size="md"
          onClick={() => setOpened((o) => !o)}
          aria-label="显示与筛选"
        >
          <IconAdjustments size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="md" style={{ minWidth: 220 }}>
          <Text fw={600} size="sm">
            显示设置
          </Text>
          <Stack gap="xs">
            <Switch
              size="xs"
              label="FC 图标"
              checked={value.showFc}
              onChange={(e) => update({ showFc: e.currentTarget.checked })}
            />
            <Switch
              size="xs"
              label="FDX 图标"
              checked={value.showFs}
              onChange={(e) => update({ showFs: e.currentTarget.checked })}
            />
            <Switch
              size="xs"
              label="显示分数"
              checked={value.showScore}
              onChange={(e) => update({ showScore: e.currentTarget.checked })}
            />
            {value.showScore && (
              <>
                <SegmentedControl
                  size="xs"
                  value={value.scoreDisplayMode}
                  onChange={(v) =>
                    update({ scoreDisplayMode: v as ScoreDisplayMode })
                  }
                  data={[
                    { value: "rank", label: "字母" },
                    { value: "score", label: "具体分数" },
                  ]}
                />
                {value.scoreDisplayMode === "score" && (
                  <NumberInput
                    label="小数位数"
                    size="xs"
                    min={0}
                    max={4}
                    step={1}
                    value={value.scoreDecimals}
                    onChange={(v) =>
                      update({ scoreDecimals: typeof v === "number" ? v : 2 })
                    }
                  />
                )}
              </>
            )}
          </Stack>

          <Text fw={600} size="sm">
            筛选
          </Text>
          <Stack gap="xs">
            <Group gap="xs" align="end">
              <NumberInput
                label="分数下限"
                size="xs"
                placeholder="0"
                min={0}
                max={101}
                step={0.5}
                decimalScale={4}
                value={value.scoreMin ?? ""}
                onChange={(v) =>
                  update({ scoreMin: typeof v === "number" ? v : null })
                }
                style={{ flex: 1 }}
              />
              <NumberInput
                label="分数上限"
                size="xs"
                placeholder="101"
                min={0}
                max={101}
                step={0.5}
                decimalScale={4}
                value={value.scoreMax ?? ""}
                onChange={(v) =>
                  update({ scoreMax: typeof v === "number" ? v : null })
                }
                style={{ flex: 1 }}
              />
            </Group>
          </Stack>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * Filter a ChartEntry-like item by score range.
 * Expects the item to have a `score` field with shape { score?: string | null }.
 */
export function matchesScoreFilter(
  scoreStr: string | null | undefined,
  settings: Pick<DisplayFilterSettings, "scoreMin" | "scoreMax">,
): boolean {
  const { scoreMin, scoreMax } = settings;
  if (scoreMin === null && scoreMax === null) return true;

  if (!scoreStr) {
    // No score — include only if no filter is active
    return scoreMin === null && scoreMax === null;
  }

  const parsed = parseFloat(scoreStr.replace("%", ""));
  if (Number.isNaN(parsed)) return true;

  if (scoreMin !== null && parsed < scoreMin) return false;
  if (scoreMax !== null && parsed > scoreMax) return false;
  return true;
}
