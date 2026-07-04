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

import {
  type AdminEnvironment,
  getDefaultAdminEnvironment,
  useAdminContext,
} from "./adminUtils";
import { ScrollableTable } from "../../components/ScrollableTable";

interface WorkerLogRow {
  service: string;
  instance: string;
  workerKind: string;
  workerId: string;
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  jobId?: string;
  eventName?: string;
  errorClass?: string;
}

interface WorkerEntry {
  workerId: string;
  workerKind: string;
  lastSeenAt: string;
}

const LEVEL_COLOR: Record<WorkerLogRow["level"], string> = {
  info: "gray",
  warn: "yellow",
  error: "red",
  debug: "blue",
};

const POLL_INTERVAL_MS = 3_000;

export default function AdminWorkerLogsPage() {
  const { password } = useAdminContext();
  const [env, setEnv] = useState<AdminEnvironment>(() =>
    getDefaultAdminEnvironment(),
  );

  const [workers, setWorkers] = useState<WorkerEntry[]>([]);
  const [filterService, setFilterService] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<string | null>(null);
  const [filterWorker, setFilterWorker] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string | null>(null);
  const [filterQ, setFilterQ] = useState("");
  const [filterQDebounced, setFilterQDebounced] = useState("");
  const [sinceMinutes, setSinceMinutes] = useState<string | null>("15");
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
    const params = new URLSearchParams({ env });
    if (sinceMinutes) params.set("sinceMinutes", sinceMinutes);
    const res = await fetch(`/api/v1/admin/history/log-workers?${params}`, {
      headers: { "x-api-secret": password },
    });
    if (!res.ok) return;
    const body = (await res.json()) as WorkerEntry[];
    if (cancelled.current) return;
    setWorkers(body);
  }, [env, password, sinceMinutes]);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("env", env);
      if (filterService) params.set("service", filterService);
      if (filterKind) params.set("workerKind", filterKind);
      if (filterWorker) params.set("workerId", filterWorker);
      if (filterLevel) params.set("level", filterLevel);
      if (filterQDebounced.trim()) params.set("q", filterQDebounced.trim());
      if (sinceMinutes) params.set("sinceMinutes", sinceMinutes);
      params.set("limit", "500");
      const res = await fetch(
        `/api/v1/admin/history/logs?${params.toString()}`,
        {
          headers: { "x-api-secret": password },
        },
      );
      if (!res.ok) return;
      const body = (await res.json()) as WorkerLogRow[];
      if (cancelled.current) return;
      setItems(body);
      setTotal(body.length);
    } finally {
      setLoading(false);
    }
  }, [
    password,
    env,
    filterService,
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
            <Text fw={600}>实时日志流</Text>
            <Text size="xs" c="dimmed">
              ClickHouse structured_logs，统一展示 backend / dxnet / sdgb 日志流；
              共 {total} 条匹配，显示最新 {items.length}
            </Text>
          </Group>
          <Group gap="xs">
            <Select
              label="数据环境"
              size="xs"
              value={env}
              onChange={(value) => setEnv(value === "prod" ? "prod" : "dev")}
              data={[
                { value: "dev", label: "dev" },
                { value: "prod", label: "prod" },
              ]}
              w={110}
            />
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
            placeholder="service"
            value={filterService}
            onChange={setFilterService}
            clearable
            searchable
            data={[
              { value: "backend", label: "backend" },
              { value: "dxnet-worker", label: "dxnet-worker" },
              { value: "sdgb-worker", label: "sdgb-worker" },
            ]}
            w={150}
          />
          <Select
            size="xs"
            placeholder="kind"
            value={filterKind}
            onChange={setFilterKind}
            clearable
            data={[
              { value: "backend", label: "backend" },
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
              { value: "info", label: "info" },
              { value: "warn", label: "warn" },
              { value: "error", label: "error" },
              { value: "debug", label: "debug" },
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
                <Table.Th w={120}>service</Table.Th>
                <Table.Th w={80}>kind</Table.Th>
                <Table.Th w={210}>instance</Table.Th>
                <Table.Th w={70}>级别</Table.Th>
                <Table.Th w={140}>context</Table.Th>
                <Table.Th w={110}>job</Table.Th>
                <Table.Th>message</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((row, idx) => (
                <Table.Tr key={`${row.ts}-${row.service}-${row.workerId}-${idx}`}>
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
                    <Badge size="xs" variant="light" color={serviceColor(row.service)}>
                      {row.service || "-"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light">
                      {row.workerKind || "-"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace" c="dimmed">
                      {row.workerId || row.instance || "-"}
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
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {row.eventName || row.errorClass || "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace" c="dimmed" lineClamp={1}>
                      {row.jobId ? row.jobId.slice(0, 8) : "-"}
                    </Text>
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
                  <Table.Td colSpan={8}>
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

function serviceColor(service: string): string {
  if (service === "backend") return "blue";
  if (service === "dxnet-worker") return "orange";
  if (service === "sdgb-worker") return "grape";
  return "gray";
}
