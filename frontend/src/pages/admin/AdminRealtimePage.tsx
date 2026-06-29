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

import {
  type ActiveJob,
  type ActiveJobsStats,
  type BotStatus,
  useAdminContext,
} from "./adminUtils";

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
  const [bots, setBots] = useState<BotStatus[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJobsStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const headers = { "x-api-secret": password };
      const [overviewRes, botsRes, activeJobsRes] = await Promise.all([
        fetch("/api/v1/admin/realtime/overview?env=prod", { headers }),
        fetch("/api/v1/admin/bots", { headers }),
        fetch("/api/v1/admin/dxnet-jobs/active", { headers }),
      ]);
      if (overviewRes.ok) {
        setData((await overviewRes.json()) as RealtimeOverview);
      }
      if (botsRes.ok) {
        setBots((await botsRes.json()) as BotStatus[]);
      }
      if (activeJobsRes.ok) {
        setActiveJobs((await activeJobsRes.json()) as ActiveJobsStats);
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
          <Title order={2}>实时监控</Title>
          <Text size="sm" c="dimmed">
            当前健康状态、Bot 可用性、实时任务、队列和最近错误
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
          value={clickhouse?.ping ? "正常" : clickhouse?.enabled ? "异常" : "关闭"}
          color={clickhouse?.ping ? "green" : clickhouse?.enabled ? "red" : "gray"}
        />
        <MetricCard
          label="可用 Bot"
          value={`${data?.bots?.available ?? 0}/${data?.bots?.total ?? 0}`}
          color={(data?.bots?.available ?? 0) > 0 ? "green" : "red"}
        />
        <MetricCard
          label="可用 Cabinet Bot"
          value={String(data?.bots?.cabinetAvailable ?? 0)}
          color={(data?.bots?.cabinetAvailable ?? 0) > 0 ? "green" : "red"}
        />
        <MetricCard
          label="ClickHouse 写入缓冲"
          value={`${clickhouse?.bufferedRows ?? 0} 待写 / ${
            clickhouse?.droppedRows ?? 0
          } 丢弃`}
          color={(clickhouse?.droppedRows ?? 0) > 0 ? "red" : "blue"}
        />
      </SimpleGrid>

      {clickhouse?.lastError && (
        <Card withBorder>
          <Text c="red" size="sm">
            ClickHouse 最近错误：{clickhouse.lastError}
          </Text>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <BotStatusCard bots={bots} />
        <ActiveJobsCard activeJobs={activeJobs} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <QueueCard title="DXNet 队列" queue={data?.queues?.dxnet} />
        <QueueCard title="SDGB 队列" queue={data?.queues?.sdgb} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <RowsCard title="最近 15 分钟 HTTP 5xx" rows={data?.recentErrors?.http} />
        <RowsCard
          title="最近 15 分钟外部调用错误"
          rows={data?.recentErrors?.externalApi}
        />
      </SimpleGrid>

      <RowsCard title="今日外部调用量" rows={data?.usageToday} />
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
      <Text size="xs" c="dimmed" fw={700}>
        {label}
      </Text>
      <Badge color={color} size="lg" mt="sm">
        {value}
      </Badge>
    </Card>
  );
}

function BotStatusCard({ bots }: { bots: BotStatus[] }) {
  const sorted = [...bots].sort((a, b) => {
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }
    return (a.remark ?? a.friendCode).localeCompare(b.remark ?? b.friendCode);
  });

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Title order={4}>Bot 状态</Title>
        <Badge variant="light">
          {sorted.filter((bot) => bot.available).length}/{sorted.length} 可用
        </Badge>
      </Group>
      {!sorted.length ? (
        <Text size="sm" c="dimmed">
          暂无 Bot 状态
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Bot</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>好友数</Table.Th>
                <Table.Th>Cabinet</Table.Th>
                <Table.Th>上报时间</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sorted.map((bot) => (
                <Table.Tr key={bot.friendCode}>
                  <Table.Td>
                    <Stack gap={0}>
                      <Text size="sm" fw={600}>
                        {bot.remark || bot.friendCode}
                      </Text>
                      {bot.remark && (
                        <Text size="xs" c="dimmed" ff="monospace">
                          {bot.friendCode}
                        </Text>
                      )}
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={bot.available ? "green" : "red"} variant="light">
                      {bot.available ? "可用" : "不可用"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{bot.friendCount ?? "-"}</Table.Td>
                  <Table.Td>
                    <Badge
                      color={bot.cabinetUserId ? "green" : "gray"}
                      variant="light"
                    >
                      {bot.cabinetUserId ? "已绑定" : "未绑定"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {formatTime(bot.lastReportedAt)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

function ActiveJobsCard({ activeJobs }: { activeJobs: ActiveJobsStats | null }) {
  const jobs = activeJobs?.jobs ?? [];

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Title order={4}>实时任务监控</Title>
        <Group gap="xs">
          <Badge color="yellow" variant="light">
            排队 {activeJobs?.queuedCount ?? 0}
          </Badge>
          <Badge color="blue" variant="light">
            处理中 {activeJobs?.processingCount ?? 0}
          </Badge>
        </Group>
      </Group>
      {!jobs.length ? (
        <Text size="sm" c="dimmed">
          当前没有活跃 DXNet 任务
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={720}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Job</Table.Th>
                <Table.Th>用户</Table.Th>
                <Table.Th>类型 / 阶段</Table.Th>
                <Table.Th>Bot</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>耗时</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {jobs.map((job) => (
                <ActiveJobRow key={job.id} job={job} />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

function ActiveJobRow({ job }: { job: ActiveJob }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="xs" ff="monospace">
          {job.id.slice(0, 8)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs" ff="monospace">
          {job.friendCode}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={0}>
          <Text size="sm">{job.jobType}</Text>
          <Text size="xs" c="dimmed">
            {job.stage}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text size="xs" ff="monospace" c="dimmed">
          {job.botUserFriendCode ?? "-"}
        </Text>
      </Table.Td>
      <Table.Td>
        <Badge
          color={job.status === "processing" ? "blue" : "yellow"}
          variant="light"
        >
          {job.status === "processing" ? "处理中" : "排队中"}
        </Badge>
      </Table.Td>
      <Table.Td>{formatDuration(job.runningDuration)}</Table.Td>
    </Table.Tr>
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

function formatTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(value: number | null | undefined): string {
  if (!Number.isFinite(value ?? NaN)) {
    return "-";
  }
  const seconds = Math.max(0, Math.floor((value ?? 0) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}
