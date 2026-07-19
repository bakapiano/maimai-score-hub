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
    </Stack>
  );
}
