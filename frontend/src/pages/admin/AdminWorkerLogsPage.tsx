import {
  Badge,
  Button,
  Card,
  Group,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconLogs, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAdminContext } from "./adminUtils";
import { ScrollableTable } from "../../components/ScrollableTable";

interface WorkerLogRow {
  workerKind: string;
  workerId: string;
  ts: string;
  level: "log" | "warn" | "error";
  message: string;
}

interface WorkerEntry {
  workerId: string;
  workerKind: string;
  lastSeenAt: string;
}

const LEVEL_COLOR: Record<WorkerLogRow["level"], string> = {
  log: "gray",
  warn: "yellow",
  error: "red",
};

const POLL_INTERVAL_MS = 3_000;

export default function AdminWorkerLogsPage() {
  const { password } = useAdminContext();

  const [workers, setWorkers] = useState<WorkerEntry[]>([]);
  const [filterKind, setFilterKind] = useState<string | null>(null);
  const [filterWorker, setFilterWorker] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string | null>(null);
  const [filterQ, setFilterQ] = useState("");
  const [filterQDebounced, setFilterQDebounced] = useState("");
  const [sinceMinutes, setSinceMinutes] = useState<string | null>("60");
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    const id = window.setTimeout(() => setFilterQDebounced(filterQ), 300);
    return () => window.clearTimeout(id);
  }, [filterQ]);

  const [items, setItems] = useState<WorkerLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const cancelled = useRef(false);

  const loadWorkers = useCallback(async () => {
    if (!password) return;
    const res = await fetch("/api/v1/admin/worker-logs/workers", {
      headers: { "x-api-secret": password },
    });
    if (!res.ok) return;
    const body = (await res.json()) as WorkerEntry[];
    if (cancelled.current) return;
    setWorkers(body);
  }, [password]);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterKind) params.set("workerKind", filterKind);
      if (filterWorker) params.set("workerId", filterWorker);
      if (filterLevel) params.set("level", filterLevel);
      if (filterQDebounced.trim()) params.set("q", filterQDebounced.trim());
      if (sinceMinutes) params.set("sinceMinutes", sinceMinutes);
      params.set("limit", "500");
      const res = await fetch(
        `/api/v1/admin/worker-logs?${params.toString()}`,
        {
          headers: { "x-api-secret": password },
        },
      );
      if (!res.ok) return;
      const body = (await res.json()) as {
        items: WorkerLogRow[];
        total: number;
      };
      if (cancelled.current) return;
      setItems(body.items);
      setTotal(body.total);
    } finally {
      setLoading(false);
    }
  }, [
    password,
    filterKind,
    filterWorker,
    filterLevel,
    filterQDebounced,
    sinceMinutes,
  ]);

  useEffect(() => {
    cancelled.current = false;
    void loadWorkers();
    void load();
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      void loadWorkers();
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      window.clearInterval(id);
    };
  }, [load, loadWorkers, autoRefresh]);

  return (
    <Stack gap="md">
      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <IconLogs size={20} />
            <Text fw={600}>Worker 日志</Text>
            <Text size="xs" c="dimmed">
              共 {total} 条匹配，显示最新 {items.length}
            </Text>
          </Group>
          <Group gap="xs">
            <Switch
              label="自动刷新"
              size="sm"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
            />
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={14} />}
              loading={loading}
              onClick={() => {
                void load();
                void loadWorkers();
              }}
            >
              立即刷新
            </Button>
          </Group>
        </Group>
      </Card>

      <Card withBorder padding="md" radius="md">
        <Group gap="xs" wrap="wrap">
          <Select
            size="xs"
            placeholder="类型"
            value={filterKind}
            onChange={setFilterKind}
            clearable
            data={[
              { value: "sdgb", label: "sdgb" },
              { value: "dxnet", label: "dxnet" },
            ]}
            w={110}
          />
          <Select
            size="xs"
            placeholder="worker 实例"
            value={filterWorker}
            onChange={setFilterWorker}
            clearable
            searchable
            data={workers.map((w) => ({
              value: w.workerId,
              label: `${w.workerKind} · ${w.workerId}`,
            }))}
            w={260}
          />
          <Select
            size="xs"
            placeholder="级别"
            value={filterLevel}
            onChange={setFilterLevel}
            clearable
            data={[
              { value: "log", label: "log" },
              { value: "warn", label: "warn" },
              { value: "error", label: "error" },
            ]}
            w={110}
          />
          <Select
            size="xs"
            placeholder="时间窗口"
            value={sinceMinutes}
            onChange={setSinceMinutes}
            data={[
              { value: "5", label: "近 5 分钟" },
              { value: "15", label: "近 15 分钟" },
              { value: "60", label: "近 1 小时" },
              { value: "360", label: "近 6 小时" },
              { value: "1440", label: "近 24 小时" },
            ]}
            w={140}
          />
          <TextInput
            size="xs"
            placeholder="message 包含..."
            value={filterQ}
            onChange={(e) => setFilterQ(e.currentTarget.value)}
            w={220}
          />
        </Group>
      </Card>

      <Card withBorder padding="md" radius="md">
        <ScrollArea>
          <ScrollableTable withTableBorder withColumnBorders striped fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={170}>时间</Table.Th>
                <Table.Th w={70}>kind</Table.Th>
                <Table.Th w={210}>workerId</Table.Th>
                <Table.Th w={70}>级别</Table.Th>
                <Table.Th>message</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((row, idx) => (
                <Table.Tr key={`${row.ts}-${row.workerId}-${idx}`}>
                  <Table.Td>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {new Date(row.ts).toLocaleTimeString("zh-CN", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                      .
                      {String(new Date(row.ts).getMilliseconds()).padStart(
                        3,
                        "0",
                      )}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light">
                      {row.workerKind}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace" c="dimmed">
                      {row.workerId}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="xs"
                      color={LEVEL_COLOR[row.level]}
                      variant="light"
                    >
                      {row.level}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      size="xs"
                      ff="monospace"
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                      c={row.level === "error" ? "red" : undefined}
                    >
                      {row.message}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {items.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text size="sm" c="dimmed" ta="center">
                      暂无符合条件的日志
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </ScrollableTable>
        </ScrollArea>
      </Card>
    </Stack>
  );
}
