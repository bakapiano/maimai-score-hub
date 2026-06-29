import {
  Badge,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import { useAdminContext } from "./adminUtils";

type RealtimeOverview = {
  environment: string;
  generatedAt: string;
  system?: {
    clickhouse?: {
      enabled: boolean;
      ping: boolean;
      bufferedRows: number;
      droppedRows: number;
      insertedRows: number;
      lastError: string | null;
    };
  };
  bots?: {
    total: number;
    available: number;
    cabinetAvailable: number;
  };
  queues?: {
    dxnet?: Record<string, number | null>;
    sdgb?: Record<string, number | null>;
  };
  recentErrors?: {
    http?: Array<Record<string, unknown>>;
    externalApi?: Array<Record<string, unknown>>;
  };
  usageToday?: Array<Record<string, unknown>>;
};

const REFRESH_MS = 10_000;

export default function AdminRealtimePage() {
  const { password } = useAdminContext();
  const [data, setData] = useState<RealtimeOverview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/realtime/overview?env=prod", {
        headers: { "x-api-secret": password },
      });
      if (res.ok) {
        setData((await res.json()) as RealtimeOverview);
      }
    } finally {
      setLoading(false);
    }
  }, [password]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const clickhouse = data?.system?.clickhouse;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Stack gap={0}>
          <Title order={2}>Realtime</Title>
          <Text size="sm" c="dimmed">
            当前健康状态、bot、队列、最近错误和今日外部调用压力
          </Text>
        </Stack>
        <Button
          leftSection={<IconRefresh size={16} />}
          onClick={() => void load()}
          loading={loading}
          variant="light"
        >
          刷新
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <MetricCard
          label="ClickHouse"
          value={clickhouse?.ping ? "OK" : clickhouse?.enabled ? "Down" : "Off"}
          color={clickhouse?.ping ? "green" : clickhouse?.enabled ? "red" : "gray"}
        />
        <MetricCard
          label="可用 bot"
          value={`${data?.bots?.available ?? 0}/${data?.bots?.total ?? 0}`}
          color={(data?.bots?.available ?? 0) > 0 ? "green" : "red"}
        />
        <MetricCard
          label="可用 cabinet bot"
          value={String(data?.bots?.cabinetAvailable ?? 0)}
          color={(data?.bots?.cabinetAvailable ?? 0) > 0 ? "green" : "red"}
        />
        <MetricCard
          label="ClickHouse buffer"
          value={`${clickhouse?.bufferedRows ?? 0} buffered / ${
            clickhouse?.droppedRows ?? 0
          } dropped`}
          color={(clickhouse?.droppedRows ?? 0) > 0 ? "red" : "blue"}
        />
      </SimpleGrid>

      {clickhouse?.lastError && (
        <Card withBorder>
          <Text c="red" size="sm">
            ClickHouse last error: {clickhouse.lastError}
          </Text>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <QueueCard title="DXNet queue" queue={data?.queues?.dxnet} />
        <QueueCard title="SDGB queue" queue={data?.queues?.sdgb} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <RowsCard title="HTTP 5xx last 15m" rows={data?.recentErrors?.http} />
        <RowsCard
          title="External API errors last 15m"
          rows={data?.recentErrors?.externalApi}
        />
      </SimpleGrid>

      <RowsCard title="External API usage today" rows={data?.usageToday} />
    </Stack>
  );
}

function MetricCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <Card withBorder>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Badge color={color} size="lg" mt="sm">
        {value}
      </Badge>
    </Card>
  );
}

function QueueCard({
  title,
  queue,
}: {
  title: string;
  queue?: Record<string, number | null>;
}) {
  return (
    <Card withBorder>
      <Title order={4}>{title}</Title>
      <Group mt="sm">
        {Object.entries(queue ?? {}).map(([key, value]) => (
          <Badge key={key} variant="light">
            {key}: {value ?? "-"}
          </Badge>
        ))}
      </Group>
    </Card>
  );
}

function RowsCard({
  title,
  rows,
}: {
  title: string;
  rows?: Array<Record<string, unknown>>;
}) {
  const keys = Array.from(new Set((rows ?? []).flatMap((row) => Object.keys(row))));
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        {title}
      </Title>
      {!rows?.length ? (
        <Text size="sm" c="dimmed">
          暂无数据
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={500}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                {keys.map((key) => (
                  <Table.Th key={key}>{key}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row, index) => (
                <Table.Tr key={index}>
                  {keys.map((key) => (
                    <Table.Td key={key}>{String(row[key] ?? "")}</Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}
