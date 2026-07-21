import {
  ActionIcon,
  Box,
  Button,
  Group,
  SegmentedControl,
  Text,
} from "@mantine/core";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useEffect, useRef } from "react";

import classes from "./ScoreHistoryDateSelector.module.css";

type HistoryDay = { day: string; count: number };

type Props = {
  days: HistoryDay[];
  selectedDay: string | null;
  onChange: (day: string) => void;
  loading: boolean;
  hasEarlier: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
};

function dayLabel(day: string) {
  const [, month, date] = day.split("-");
  return `${month}/${date}`;
}

export function ScoreHistoryDateSelector({
  days,
  selectedDay,
  onChange,
  loading,
  hasEarlier,
  loadingMore,
  onLoadMore,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>("[data-active]")
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [selectedDay]);

  const selectedIndex = selectedDay
    ? days.findIndex((item) => item.day === selectedDay)
    : -1;
  const moveSelection = (offset: number) => {
    const target = days[selectedIndex + offset];
    if (target) {
      onChange(target.day);
    }
  };

  if (loading && !days.length) {
    return null;
  }

  if (!days.length) {
    return hasEarlier ? (
      <Button loading={loadingMore} onClick={onLoadMore}>
        加载更多
      </Button>
    ) : (
      <Text size="sm" c="dimmed">
        已加载范围内暂无成绩历史
      </Text>
    );
  }

  return (
    <Group gap="xs" wrap="nowrap" className={classes.root}>
      {hasEarlier ? (
        <Button
          size="sm"
          variant="light"
          loading={loadingMore}
          onClick={onLoadMore}
          className={classes.loadMore}
        >
          加载更多
        </Button>
      ) : null}
      <Box pos="relative" className={classes.selectorWrap}>
        <ActionIcon
          variant="filled"
          color="blue"
          size="md"
          radius="xl"
          onClick={() => moveSelection(-1)}
          disabled={selectedIndex <= 0}
          aria-label="向左滚动日期"
          className={`${classes.scrollButton} ${classes.scrollLeft}`}
        >
          <IconChevronLeft size={18} />
        </ActionIcon>
        <Box ref={scrollRef} className={classes.scroller}>
          <SegmentedControl
            value={selectedDay ?? ""}
            onChange={onChange}
            data={days.map((item) => ({
              value: item.day,
              label: (
                <span title={`${item.day} · ${item.count} 条`}>
                  {dayLabel(item.day)}
                </span>
              ),
            }))}
            disabled={loadingMore}
            size="md"
            color="blue"
            className={classes.selector}
          />
        </Box>
        <ActionIcon
          variant="filled"
          color="blue"
          size="md"
          radius="xl"
          onClick={() => moveSelection(1)}
          disabled={selectedIndex < 0 || selectedIndex >= days.length - 1}
          aria-label="向右滚动日期"
          className={`${classes.scrollButton} ${classes.scrollRight}`}
        >
          <IconChevronRight size={18} />
        </ActionIcon>
      </Box>
    </Group>
  );
}
