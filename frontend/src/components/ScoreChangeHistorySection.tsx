import {
  Badge,
  Box,
  Button,
  Center,
  Collapse,
  Group,
  Image,
  Loader,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import type {
  ScoreChange,
  ScoreChangeField,
  ScoreChangeSourceType,
  ScoreChangeValue,
} from "@maimai-score-hub/shared";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import { fetchScoreChangeHistory } from "../api/scoreChanges";
import { useAuth } from "../providers/AuthContext";
import { getAchievementRank } from "../utils/achievementRank";
import { getDxStarForScore, parseDxScore } from "../utils/dxScore";
import {
  renderRank,
  type DetailedMusicScoreCardProps,
} from "./MusicScoreCard";
import classes from "./ScoreDetailModal.module.css";

const ASSET_BASE = "/mai/pic";

type Props = {
  opened: boolean;
  scoreData: DetailedMusicScoreCardProps;
  maxDxScore: number | null;
};

type VisibleField = Extract<ScoreChangeField, "score" | "dxScore" | "fc" | "fs">;

const FIELD_LABELS: Record<VisibleField, string> = {
  score: "达成率",
  dxScore: "DX 分",
  fc: "FC",
  fs: "FS",
};

const SOURCE_LABELS: Record<ScoreChangeSourceType, string> = {
  dxnet_update_score: "DXNET",
  auto_update_rival: "自动更新",
  auto_update_fcfs: "最近游玩",
  cabinet_qr_update: "二维码",
};

const SOURCE_COLORS: Record<ScoreChangeSourceType, string> = {
  dxnet_update_score: "blue",
  auto_update_rival: "teal",
  auto_update_fcfs: "grape",
  cabinet_qr_update: "orange",
};

const VISIBLE_FIELDS: VisibleField[] = ["score", "dxScore", "fc", "fs"];

function formatObservedAt(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatValue(
  field: VisibleField,
  value: ScoreChangeValue,
) {
  const raw = value[field];
  if (raw === null || raw === undefined || raw === "") {
    return "N/A";
  }
  if (field === "fc" || field === "fs") {
    return String(raw).toUpperCase();
  }
  if (field === "dxScore") {
    const numeric = parseDxScore(raw);
    return numeric !== null ? numeric.toLocaleString("zh-CN") : String(raw);
  }
  return String(raw);
}

function HistoryValue({
  field,
  value,
  maxDxScore,
}: {
  field: VisibleField;
  value: ScoreChangeValue;
  maxDxScore: number | null;
}) {
  const text = formatValue(field, value);
  if (text === "N/A") {
    return <Text fw={600}>N/A</Text>;
  }

  if (field === "score") {
    const rank = getAchievementRank(value.score);
    return (
      <Group gap={5} wrap="nowrap" className={classes.historyValueSide}>
        {rank ? renderRank(rank, { compact: true, width: 42 }) : null}
        <Text fw={600}>{text}</Text>
      </Group>
    );
  }

  if (field === "dxScore") {
    const stars = getDxStarForScore(parseDxScore(value.dxScore), maxDxScore);
    return (
      <Group gap={5} wrap="nowrap" className={classes.historyValueSide}>
        <Text fw={600}>{text}</Text>
        {stars !== null && stars > 0 ? (
          <Image
            src={`${ASSET_BASE}/UI_GAM_Gauge_DXScoreIcon_0${stars}.png`}
            alt={`${stars} 星`}
            className={classes.historyDxStarImage}
          />
        ) : null}
      </Group>
    );
  }

  return <Text fw={600}>{text}</Text>;
}

function changedValueFields(change: ScoreChange) {
  const changed = new Set(change.changedFields);
  return VISIBLE_FIELDS.filter((field) => changed.has(field));
}

function HistoryRow({
  change,
  maxDxScore,
}: {
  change: ScoreChange;
  maxDxScore: number | null;
}) {
  const fields = changedValueFields(change);
  const isNew = change.changedFields.includes("newChart");

  return (
    <Paper withBorder p="sm" radius="md" className={classes.historyRow}>
      <Group justify="space-between" align="flex-start" gap="xs">
        <Group gap="xs">
          <Text size="xs" c="dimmed" className={classes.historyTime}>
            {formatObservedAt(change.observedAt)}
          </Text>
          <Badge
            size="xs"
            variant="light"
            color={SOURCE_COLORS[change.sourceType]}
          >
            {SOURCE_LABELS[change.sourceType]}
          </Badge>
        </Group>
        {isNew ? (
          <Badge size="xs" variant="light" color="cyan">
            首次记录
          </Badge>
        ) : null}
      </Group>

      <Group gap="xs" mt="xs" align="stretch">
        {fields.map((field) => (
          <Box key={field} className={classes.historyChangeValue}>
            <Text size="xs" c="dimmed">
              {FIELD_LABELS[field]}
            </Text>
            <Group gap={5} wrap="nowrap" className={classes.historyTransition}>
              <HistoryValue
                field={field}
                value={change.before}
                maxDxScore={maxDxScore}
              />
              <Text component="span" c="dimmed">
                →
              </Text>
              <HistoryValue
                field={field}
                value={change.after}
                maxDxScore={maxDxScore}
              />
            </Group>
          </Box>
        ))}
        {!fields.length ? (
          <Text size="sm" c="dimmed">
            本次未改变达成率、DX 分数、FC 或 FS
          </Text>
        ) : null}
      </Group>
    </Paper>
  );
}

export function ScoreChangeHistorySection({
  opened,
  scoreData,
  maxDxScore,
}: Props) {
  const { token, offline } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ScoreChange[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const selectionKey = `${scoreData.musicId}:${scoreData.chartIndex}:${scoreData.type}`;

  useEffect(() => {
    if (!opened) {
      setExpanded(false);
    }
  }, [opened, selectionKey]);

  useEffect(() => {
    requestRef.current?.abort();
    setItems([]);
    setNextCursor(null);
    setError(null);
    setLoadingMore(false);

    if (!opened || !token || offline) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    void fetchScoreChangeHistory({
      token,
      musicId: scoreData.musicId,
      chartIndex: scoreData.chartIndex,
      type: scoreData.type,
      signal: controller.signal,
    })
      .then((result) => {
        setItems(result.items);
        setNextCursor(result.nextCursor);
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
  }, [offline, opened, reloadKey, scoreData, selectionKey, token]);

  const loadMore = async () => {
    if (!token || !nextCursor || loadingMore) {
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchScoreChangeHistory({
        token,
        musicId: scoreData.musicId,
        chartIndex: scoreData.chartIndex,
        type: scoreData.type,
        cursor: nextCursor,
        signal: controller.signal,
      });
      setItems((current) => [...current, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "请求失败");
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoadingMore(false);
      }
    }
  };

  return (
    <Stack gap="sm" className={classes.historySection}>
      <UnstyledButton
        className={classes.historyToggle}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? "收起成绩历史" : "展开成绩历史"}
      >
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={700}>成绩历史</Text>
            {items.length ? (
              <Badge variant="light" color="gray">
                {items.length} 条
              </Badge>
            ) : null}
          </Group>
          {expanded ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </Group>
      </UnstyledButton>

      <Collapse in={expanded}>
        {offline || !token ? (
          <Text size="sm" c="dimmed">
            离线模式下无法读取成绩历史。
          </Text>
        ) : loading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : error && !items.length ? (
          <Stack gap="xs" align="flex-start">
            <Text size="sm" c="red">
              {error}
            </Text>
            <Button
              size="xs"
              variant="light"
              onClick={() => setReloadKey((v) => v + 1)}
            >
              重试
            </Button>
          </Stack>
        ) : !items.length ? (
          <Text size="sm" c="dimmed">
            暂无变化记录。记录仅从成绩历史功能上线后开始积累。
          </Text>
        ) : (
          <Stack gap="xs">
            {items.map((change) => (
              <HistoryRow
                key={change.id}
                change={change}
                maxDxScore={maxDxScore}
              />
            ))}
            {error ? (
              <Text size="sm" c="red">
                {error}
              </Text>
            ) : null}
            {nextCursor ? (
              <Center>
                <Button
                  size="xs"
                  variant="subtle"
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                >
                  加载更多
                </Button>
              </Center>
            ) : null}
          </Stack>
        )}
      </Collapse>
    </Stack>
  );
}
