import {
  ActionIcon,
  Box,
  Group,
  NumberInput,
  Popover,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { IconAdjustments } from "@tabler/icons-react";
import { useState } from "react";

import type {
  DisplayFilterSettings,
  ScoreDisplayMode,
} from "./ScoreDisplayFilter.model";

type ScoreDisplayFilterProps = {
  value: DisplayFilterSettings;
  onChange: (value: DisplayFilterSettings) => void;
};

export function ScoreDisplayFilterContent({
  value,
  onChange,
}: ScoreDisplayFilterProps) {
  const update = (patch: Partial<DisplayFilterSettings>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <Stack gap="md">
      <Box>
        <Text size="xs" fw={600} c="dimmed" mb="xs">
          筛选条件
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Stack gap="xs">
            <Text size="xs" fw={500}>
              显示设置
            </Text>
            <Switch
              size="sm"
              label="FC 图标"
              checked={value.showFc}
              onChange={(e) => update({ showFc: e.currentTarget.checked })}
            />
            <Switch
              size="sm"
              label="FDX 图标"
              checked={value.showFs}
              onChange={(e) => update({ showFs: e.currentTarget.checked })}
            />
            <Switch
              size="sm"
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

          <Stack gap="xs">
            <Text size="xs" fw={500}>
              分数范围
            </Text>
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
        </SimpleGrid>
      </Box>
    </Stack>
  );
}

export function ScoreDisplayFilter({ value, onChange }: ScoreDisplayFilterProps) {
  const [opened, setOpened] = useState(false);

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
        <Box style={{ minWidth: 280 }}>
          <ScoreDisplayFilterContent value={value} onChange={onChange} />
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
}
