import { Select, Stack, Switch } from "@mantine/core";

import type { ScoreHistorySettings } from "./scoreHistoryTime";

type Props = {
  settings: ScoreHistorySettings;
  onSettingsChange: (patch: Partial<ScoreHistorySettings>) => void;
};

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, "0")}:00`,
}));

export function ScoreHistoryFilterPanel({
  settings,
  onSettingsChange,
}: Props) {
  return (
    <Stack gap="sm">
      <Select
        label="日期分界时间"
        data={HOUR_OPTIONS}
        value={String(settings.dayStartHour)}
        allowDeselect={false}
        onChange={(value) =>
          onSettingsChange({ dayStartHour: Number(value ?? 6) })
        }
      />
      <Switch
        label="合并当日推分"
        checked={settings.mergeSameChart}
        onChange={(event) =>
          onSettingsChange({ mergeSameChart: event.currentTarget.checked })
        }
      />
      <Switch
        label="忽略无关键变化的记录"
        description="仅保留评级档位、DX 星级或 FC/FS 状态发生变化的记录"
        checked={settings.keyChangesOnly}
        onChange={(event) =>
          onSettingsChange({ keyChangesOnly: event.currentTarget.checked })
        }
      />
    </Stack>
  );
}
