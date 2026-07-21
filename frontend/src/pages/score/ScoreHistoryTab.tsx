import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { ScoreChange } from "@maimai-score-hub/shared";
import { IconDownload } from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { fetchScoreHistoryFeed } from "../../api/scoreChanges";
import { apiUrl } from "../../api/baseUrl";
import {
  DesktopFilterCard,
  MobileFilterModalButton,
} from "../../components/ResponsiveFilterPanel";
import { useAuth } from "../../providers/AuthContext";
import { useMusic } from "../../providers/MusicContext";
import type { MusicRow } from "../../types/music";
import { downloadBlob } from "../../utils/downloadBlob";
import { ScoreHistoryFilterPanel } from "./ScoreHistoryFilterPanel";
import { ScoreHistoryCards } from "./ScoreHistoryCards";
import { ScoreHistoryDateSelector } from "./ScoreHistoryDateSelector";
import {
  DEFAULT_SCORE_HISTORY_SETTINGS,
  businessDayKey,
  businessDayLabel,
  businessDayRange,
  currentBusinessDayKey,
  historyDisplayItems,
  initialHistoryWindow,
  previousHistoryWindow,
  type ScoreHistoryDisplayItem,
  type ScoreHistorySettings,
} from "./scoreHistoryTime";

type CalendarDay = { day: string; count: number };
type HistoryGroup = {
  key: string;
  label: string;
  items: ScoreHistoryDisplayItem[];
};
const SETTINGS_KEY = "score_history_settings_v2";

function readSettings(): ScoreHistorySettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as
      | Partial<ScoreHistorySettings>
      | null;
    return {
      dayStartHour:
        typeof value?.dayStartHour === "number" &&
        value.dayStartHour >= 0 &&
        value.dayStartHour <= 23
          ? Math.floor(value.dayStartHour)
          : 6,
      mergeSameChart:
        typeof value?.mergeSameChart === "boolean"
          ? value.mergeSameChart
          : DEFAULT_SCORE_HISTORY_SETTINGS.mergeSameChart,
    };
  } catch {
    return DEFAULT_SCORE_HISTORY_SETTINGS;
  }
}

function saveSettings(settings: ScoreHistorySettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore unavailable local storage.
  }
}

function groupHistoryItems(
  items: ScoreHistoryDisplayItem[],
  dayStartHour: number,
) {
  const groups: HistoryGroup[] = [];
  for (const item of items) {
    const key = businessDayKey(item.change.observedAt, dayStartHour);
    const last = groups.at(-1);
    if (last?.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, label: businessDayLabel(key), items: [item] });
    }
  }
  return groups;
}

function isDayLoaded(
  day: string,
  start: number,
  end: number,
  dayStartHour: number,
) {
  const range = businessDayRange(day, dayStartHour);
  return range.from >= start && range.to <= end;
}

function defaultLoadedDay(
  days: CalendarDay[],
  start: number,
  end: number,
  dayStartHour: number,
) {
  const loaded = days.filter((day) =>
    isDayLoaded(day.day, start, end, dayStartHour),
  );
  const today = currentBusinessDayKey(dayStartHour);
  return loaded.some((day) => day.day === today)
    ? today
    : (loaded[0]?.day ?? null);
}

function appendUniqueChanges(current: ScoreChange[], incoming: ScoreChange[]) {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

function summarizeLoadedDays(items: ScoreChange[], dayStartHour: number) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const day = businessDayKey(item.observedAt, dayStartHour);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

function HistoryResults({
  loading,
  error,
  loadedItemCount,
  visibleItemCount,
  selectedDay,
  groups,
  musicMap,
}: {
  loading: boolean;
  error: string | null;
  loadedItemCount: number;
  visibleItemCount: number;
  selectedDay: string | null;
  groups: HistoryGroup[];
  musicMap: Map<string, MusicRow>;
}) {
  if (loading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (error && loadedItemCount === 0) {
    return (
      <Text c="red" ta="center" py="xl">
        {error}
      </Text>
    );
  }
  if (visibleItemCount === 0) {
    return (
      <Stack align="center" py="xl">
        <Text c="dimmed" ta="center">
          {selectedDay ? "所选日期没有成绩历史" : "已加载范围内暂无成绩历史"}
        </Text>
      </Stack>
    );
  }
  return (
    <Stack gap="xl">
      {groups.map((group) => (
        <Stack key={group.key} gap="sm">
          <Group gap="xs">
            <Text fw={700}>{group.label}</Text>
            <Badge variant="light" color="gray">
              {group.items.length} 条
            </Badge>
          </Group>
          <ScoreHistoryCards items={group.items} musicMap={musicMap} />
        </Stack>
      ))}
      {error ? <Text c="red">{error}</Text> : null}
    </Stack>
  );
}

function HistoryHeader({
  filterPanel,
  settings,
  exporting,
  exportDisabled,
  onExport,
}: {
  filterPanel: ReactNode;
  settings: ScoreHistorySettings;
  exporting: boolean;
  exportDisabled: boolean;
  onExport: () => void;
}) {
  const filterActive =
    settings.dayStartHour !== 6 ||
    settings.mergeSameChart !==
      DEFAULT_SCORE_HISTORY_SETTINGS.mergeSameChart;
  return (
    <Group justify="space-between" align="center">
      <Title order={4} size="h5">
        成绩历史
      </Title>
      <Group gap="xs">
        <MobileFilterModalButton
          active={filterActive}
          title="成绩历史设置"
        >
          {filterPanel}
        </MobileFilterModalButton>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconDownload size={14} />}
          loading={exporting}
          disabled={exportDisabled}
          onClick={onExport}
        >
          导出图片
        </Button>
      </Group>
    </Group>
  );
}

export function ScoreHistoryTab() {
  const { token, offline } = useAuth();
  const { musicMap } = useMusic();
  const [settings, setSettings] = useState(readSettings);
  const initialFeedWindow = useMemo(() => initialHistoryWindow(settings.dayStartHour), [
    settings.dayStartHour,
  ]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [items, setItems] = useState<ScoreChange[]>([]);
  const [historyStart, setHistoryStart] = useState(initialFeedWindow.start);
  const [feedHasEarlier, setFeedHasEarlier] = useState(false);
  const [loading, setLoading] = useState(() => Boolean(token && !offline));
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    feedRequest.current?.abort();
    setItems([]);
    setFeedHasEarlier(false);
    setHistoryStart(initialFeedWindow.start);
    setError(null);
    if (!token || offline) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    feedRequest.current = controller;
    setLoading(true);
    void fetchScoreHistoryFeed({
      token,
      ...initialFeedWindow,
      signal: controller.signal,
    })
      .then((result) => {
        setItems(result.items);
        setFeedHasEarlier(result.hasEarlier);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "请求失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    initialFeedWindow,
    offline,
    token,
  ]);

  const loadedDays = useMemo(
    () => summarizeLoadedDays(items, settings.dayStartHour),
    [items, settings.dayStartHour],
  );

  useEffect(() => {
    setSelectedDay((current) => {
      const currentAvailable =
        current !== null &&
        loadedDays.some((day) => day.day === current) &&
        isDayLoaded(
          current,
          historyStart,
          initialFeedWindow.end,
          settings.dayStartHour,
        );
      return currentAvailable
        ? current
        : defaultLoadedDay(
            loadedDays,
            historyStart,
            initialFeedWindow.end,
            settings.dayStartHour,
          );
    });
  }, [
    loadedDays,
    historyStart,
    initialFeedWindow.end,
    settings.dayStartHour,
  ]);

  const selectedItems = useMemo(
    () =>
      selectedDay
        ? items.filter(
            (item) =>
              businessDayKey(item.observedAt, settings.dayStartHour) ===
              selectedDay,
          )
        : [],
    [items, selectedDay, settings.dayStartHour],
  );
  const displayItems = useMemo(
    () => historyDisplayItems(selectedItems, settings),
    [selectedItems, settings],
  );
  const groups = useMemo(() => {
    return groupHistoryItems(displayItems, settings.dayStartHour);
  }, [displayItems, settings.dayStartHour]);

  const updateSettings = (patch: Partial<ScoreHistorySettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const loadMore = async () => {
    if (!token || loadingMore || !feedHasEarlier) {
      return;
    }
    const range = previousHistoryWindow(historyStart);
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchScoreHistoryFeed({ token, ...range });
      setItems((current) => appendUniqueChanges(current, result.items));
      setHistoryStart(range.start);
      setFeedHasEarlier(result.hasEarlier);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求失败");
    } finally {
      setLoadingMore(false);
    }
  };

  const exportSelectedDay = async () => {
    if (!token || !selectedDay || exporting) {
      return;
    }
    const { from: start, to: end } = businessDayRange(
      selectedDay,
      settings.dayStartHour,
    );
    const params = new URLSearchParams({
      date: selectedDay,
      start: String(start),
      end: String(end),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
      dayStartHour: String(settings.dayStartHour),
    });
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(
        apiUrl(`/me/score-exports/history?${params}`),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw new Error(`导出失败 (HTTP ${response.status})`);
      }
      downloadBlob(await response.blob(), `score-history-${selectedDay}.png`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  const filterPanel = (
    <ScoreHistoryFilterPanel
      settings={settings}
      onSettingsChange={updateSettings}
    />
  );

  if (offline || !token) {
    return <Text c="dimmed">离线模式下无法读取成绩历史。</Text>;
  }

  if (loading && items.length === 0) {
    return (
      <Center
        mih={{
          base: "calc(100dvh - 12rem)",
          sm: "calc(100dvh - 15rem)",
        }}
      >
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="md">
      <HistoryHeader
        filterPanel={filterPanel}
        settings={settings}
        exporting={exporting}
        exportDisabled={!selectedDay}
        onExport={() => void exportSelectedDay()}
      />

      <ScoreHistoryDateSelector
        days={loadedDays}
        selectedDay={selectedDay}
        onChange={setSelectedDay}
        hasEarlier={feedHasEarlier}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
      />

      <DesktopFilterCard>{filterPanel}</DesktopFilterCard>
      <HistoryResults
        loading={loading}
        error={error}
        loadedItemCount={items.length}
        visibleItemCount={displayItems.length}
        selectedDay={selectedDay}
        groups={groups}
        musicMap={musicMap}
      />
    </Stack>
  );
}
