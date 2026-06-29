import {
  Badge,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  type ActiveJob,
  type ActiveJobsStats,
  type AdminEnvironment,
  type BotStatus,
  getDefaultAdminEnvironment,
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

type WorkerKind = "dxnet" | "sdgb" | "prober_export";

type RealtimeWorkerGroups = {
  environment: string;
  generatedAt: string;
  window: "1h" | "6h" | "24h";
  groups: WorkerGroup[];
};

type WorkerGroup = {
  workerKind: WorkerKind;
  title: string;
  workers: Array<Record<string, unknown>>;
  queueByJobType: QueueByJobType[];
  activeJobs: WorkerActiveJob[];
  successRateTrend: SuccessRateTrendPoint[];
  durationTrend: DurationTrendPoint[];
  recentErrors: RecentWorkerError[];
};

type QueueByJobType = {
  jobType: string;
  queued: number;
  processing: number;
  delayed: number;
  failed: number;
  completed: number;
  oldestQueuedAgeSeconds: number | null;
};

type WorkerActiveJob = {
  id: string;
  jobType: string;
  status: string;
  stage: string | null;
  workerId: string | null;
  botFriendCode: string | null;
  friendCode: string | null;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
};

type SuccessRateTrendPoint = {
  bucket: string;
  jobType: string;
  completed: number;
  failed: number;
  total: number;
  successRate: number;
};

type DurationTrendPoint = {
  bucket: string;
  jobType: string;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};

type RecentWorkerError = {
  jobType: string;
  errorClass: string;
  message: string;
  count: number;
};

const REFRESH_MS = 10_000;

export default function AdminRealtimePage() {
  const { password } = useAdminContext();
  const [environment, setEnvironment] = useState<AdminEnvironment>(() =>
    getDefaultAdminEnvironment(),
  );
  const [data, setData] = useState<RealtimeOverview | null>(null);
  const [workerGroups, setWorkerGroups] =
    useState<RealtimeWorkerGroups | null>(null);
  const [bots, setBots] = useState<BotStatus[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJobsStats | null>(null);
  const [workerWindow, setWorkerWindow] = useState<"1h" | "6h" | "24h">("1h");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const headers = { "x-api-secret": password };
      const [overviewRes, workerGroupsRes, botsRes, activeJobsRes] =
        await Promise.all([
        fetch(`/api/v1/admin/realtime/overview?env=${environment}`, {
          headers,
        }),
        fetch(
          `/api/v1/admin/realtime/worker-groups?env=${environment}&window=${workerWindow}`,
          { headers },
        ),
        fetch("/api/v1/admin/bots", { headers }),
        fetch("/api/v1/admin/dxnet-jobs/active", { headers }),
      ]);
      if (overviewRes.ok) {
        setData((await overviewRes.json()) as RealtimeOverview);
      }
      if (workerGroupsRes.ok) {
        setWorkerGroups((await workerGroupsRes.json()) as RealtimeWorkerGroups);
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
  }, [environment, password, workerWindow]);

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
        <Group align="flex-end">
          <Select
            label="数据环境"
            size="xs"
            value={environment}
            onChange={(value) => setEnvironment(value === "prod" ? "prod" : "dev")}
            data={[
              { value: "dev", label: "dev" },
              { value: "prod", label: "prod" },
            ]}
            w={110}
          />
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={() => void load()}
            loading={loading}
            variant="light"
          >
            刷新
          </Button>
        </Group>
      </Group>

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="overview">总览</Tabs.Tab>
          <Tabs.Tab value="dxnet">DXNet</Tabs.Tab>
          <Tabs.Tab value="sdgb">SDGB</Tabs.Tab>
          <Tabs.Tab value="prober_export">查分器导出</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview" pt="md">
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              <MetricCard
                label="ClickHouse"
                value={
                  clickhouse?.ping ? "正常" : clickhouse?.enabled ? "异常" : "关闭"
                }
                color={
                  clickhouse?.ping
                    ? "green"
                    : clickhouse?.enabled
                      ? "red"
                      : "gray"
                }
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
              <RowsCard
                title="最近 15 分钟 HTTP 5xx"
                rows={data?.recentErrors?.http}
              />
              <RowsCard
                title="最近 15 分钟外部调用错误"
                rows={data?.recentErrors?.externalApi}
              />
            </SimpleGrid>

            <RowsCard title="今日外部调用量" rows={data?.usageToday} />
          </Stack>
        </Tabs.Panel>

        {(["dxnet", "sdgb", "prober_export"] as WorkerKind[]).map((kind) => (
          <Tabs.Panel key={kind} value={kind} pt="md">
            <WorkerMonitorPanel
              group={workerGroups?.groups.find(
                (candidate) => candidate.workerKind === kind,
              )}
              window={workerWindow}
              onWindowChange={setWorkerWindow}
            />
          </Tabs.Panel>
        ))}
      </Tabs>
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

function WorkerMonitorPanel({
  group,
  window,
  onWindowChange,
}: {
  group: WorkerGroup | undefined;
  window: "1h" | "6h" | "24h";
  onWindowChange: (value: "1h" | "6h" | "24h") => void;
}) {
  if (!group) {
    return (
      <Card withBorder>
        <Text size="sm" c="dimmed">
          暂无 worker 数据
        </Text>
      </Card>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Stack gap={0}>
          <Title order={3}>{group.title}</Title>
          <Text size="sm" c="dimmed">
            按 job type 展示队列、活跃任务、成功率趋势、耗时趋势和最近错误
          </Text>
        </Stack>
        <Select
          label="趋势窗口"
          size="xs"
          value={window}
          onChange={(value) =>
            onWindowChange(value === "6h" || value === "24h" ? value : "1h")
          }
          data={[
            { value: "1h", label: "近 1 小时" },
            { value: "6h", label: "近 6 小时" },
            { value: "24h", label: "近 24 小时" },
          ]}
          w={130}
        />
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <MetricCard
          label="Worker 实例"
          value={String(group.workers.length)}
          color={group.workers.length > 0 ? "blue" : "gray"}
        />
        <MetricCard
          label="排队中"
          value={String(sumQueue(group.queueByJobType, "queued"))}
          color={sumQueue(group.queueByJobType, "queued") > 0 ? "yellow" : "gray"}
        />
        <MetricCard
          label="处理中"
          value={String(sumQueue(group.queueByJobType, "processing"))}
          color={sumQueue(group.queueByJobType, "processing") > 0 ? "blue" : "gray"}
        />
        <MetricCard
          label="最近错误"
          value={String(group.recentErrors.reduce((sum, row) => sum + row.count, 0))}
          color={group.recentErrors.length > 0 ? "red" : "gray"}
        />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <QueueByJobTypeCard rows={group.queueByJobType} />
        <WorkerInstancesCard rows={group.workers} />
      </SimpleGrid>

      <ActiveWorkerJobsCard jobs={group.activeJobs} />

      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <TrendCard
          title="成功率趋势"
          data={group.successRateTrend}
          valueKey="successRate"
          valueLabel="成功率 %"
          unit="%"
        />
        <TrendCard
          title="耗时趋势 p95"
          data={group.durationTrend}
          valueKey="p95Ms"
          valueLabel="p95 耗时"
          unit="ms"
        />
      </SimpleGrid>

      <RecentErrorsCard rows={group.recentErrors} />
    </Stack>
  );
}

function QueueByJobTypeCard({ rows }: { rows: QueueByJobType[] }) {
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        按类型队列
      </Title>
      {!rows.length ? (
        <Text size="sm" c="dimmed">
          暂无队列数据
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={680}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Job type</Table.Th>
                <Table.Th>排队</Table.Th>
                <Table.Th>处理</Table.Th>
                <Table.Th>失败</Table.Th>
                <Table.Th>完成</Table.Th>
                <Table.Th>最久排队</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.jobType}>
                  <Table.Td>{row.jobType}</Table.Td>
                  <Table.Td>{row.queued}</Table.Td>
                  <Table.Td>{row.processing}</Table.Td>
                  <Table.Td>{row.failed}</Table.Td>
                  <Table.Td>{row.completed}</Table.Td>
                  <Table.Td>{formatSeconds(row.oldestQueuedAgeSeconds)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

function WorkerInstancesCard({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        Worker 实例
      </Title>
      {!rows.length ? (
        <Text size="sm" c="dimmed">
          暂无实例/心跳数据
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>workerId</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>最近上报</Table.Th>
                <Table.Th>信息</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row, index) => (
                <Table.Tr key={`${String(row.workerId ?? index)}-${index}`}>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {String(row.workerId ?? row.botFriendCode ?? "-")}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {"available" in row ? (
                      <Badge
                        color={row.available ? "green" : "red"}
                        variant="light"
                      >
                        {row.available ? "可用" : "不可用"}
                      </Badge>
                    ) : (
                      <Badge variant="light">已上报</Badge>
                    )}
                  </Table.Td>
                  <Table.Td>{formatTime(String(row.lastSeenAt ?? ""))}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {formatWorkerInfo(row)}
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

function ActiveWorkerJobsCard({ jobs }: { jobs: WorkerActiveJob[] }) {
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        活跃任务
      </Title>
      {!jobs.length ? (
        <Text size="sm" c="dimmed">
          当前没有活跃任务
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={820}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Job</Table.Th>
                <Table.Th>Job type</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>阶段/目标</Table.Th>
                <Table.Th>Worker/Bot</Table.Th>
                <Table.Th>用户</Table.Th>
                <Table.Th>耗时</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {jobs.map((job) => (
                <Table.Tr key={job.id}>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {job.id.slice(0, 8)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{job.jobType}</Table.Td>
                  <Table.Td>
                    <Badge
                      color={job.status === "processing" ? "blue" : "yellow"}
                      variant="light"
                    >
                      {job.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{job.stage ?? "-"}</Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {job.workerId ?? job.botFriendCode ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {job.friendCode ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>{formatDuration(job.durationMs)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

function TrendCard({
  title,
  data,
  valueKey,
  valueLabel,
  unit,
}: {
  title: string;
  data: Array<Record<string, unknown>>;
  valueKey: string;
  valueLabel: string;
  unit: string;
}) {
  const chartData = toChartData(data, valueKey);
  const jobTypes = Array.from(
    new Set(data.map((row) => String(row.jobType ?? ""))),
  ).filter(Boolean);
  const colors = ["#228be6", "#40c057", "#fa5252", "#fab005", "#7950f2", "#15aabf"];

  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        {title}
      </Title>
      {!chartData.length || !jobTypes.length ? (
        <Text size="sm" c="dimmed">
          暂无趋势数据
        </Text>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="bucketLabel" minTickGap={24} />
            <YAxis />
            <Tooltip
              formatter={(value: unknown) => [
                `${value ?? "-"}${unit}`,
                valueLabel,
              ]}
            />
            <Legend />
            {jobTypes.map((jobType, index) => (
              <Line
                key={jobType}
                type="monotone"
                dataKey={jobType}
                stroke={colors[index % colors.length]}
                dot={false}
                strokeWidth={2}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function RecentErrorsCard({ rows }: { rows: RecentWorkerError[] }) {
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        最近错误
      </Title>
      {!rows.length ? (
        <Text size="sm" c="dimmed">
          最近窗口内没有错误
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={720}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Job type</Table.Th>
                <Table.Th>错误类型</Table.Th>
                <Table.Th>消息</Table.Th>
                <Table.Th>次数</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row, index) => (
                <Table.Tr key={`${row.jobType}-${row.errorClass}-${index}`}>
                  <Table.Td>{row.jobType}</Table.Td>
                  <Table.Td>
                    <Badge color="red" variant="light">
                      {row.errorClass}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" lineClamp={2}>
                      {row.message}
                    </Text>
                  </Table.Td>
                  <Table.Td>{row.count}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
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
            {formatQueueLabel(key)}：{formatQueueValue(key, value)}
          </Badge>
        ))}
      </Group>
    </Card>
  );
}

function formatQueueLabel(key: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    processing: "处理中",
    failed: "失败",
    completed: "已完成",
    oldestQueuedAgeSeconds: "最久排队",
    oldestProcessingAgeSeconds: "最久处理",
  };
  return labels[key] ?? key;
}

function formatQueueValue(key: string, value: number | null): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (key.toLowerCase().includes("age") || key.toLowerCase().includes("seconds")) {
    return formatSeconds(value);
  }
  return String(value);
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

function sumQueue(
  rows: QueueByJobType[],
  key: "queued" | "processing" | "failed" | "completed",
): number {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

function formatWorkerInfo(row: Record<string, unknown>): string {
  const parts: string[] = [];
  if (row.remark) parts.push(`备注 ${String(row.remark)}`);
  if (row.friendCount !== undefined && row.friendCount !== null) {
    parts.push(`好友 ${String(row.friendCount)}`);
  }
  if (row.cabinetUserId) parts.push("Cabinet 已绑定");
  if (row.jobsClaimed !== undefined) {
    parts.push(`领取 ${String(row.jobsClaimed)}`);
  }
  if (row.concurrency !== undefined) {
    parts.push(`并发 ${String(row.concurrency)}`);
  }
  return parts.join(" · ") || "-";
}

function toChartData(
  rows: Array<Record<string, unknown>>,
  valueKey: string,
): Array<Record<string, string | number | null>> {
  const byBucket = new Map<string, Record<string, string | number | null>>();
  for (const row of rows) {
    const bucket = String(row.bucket ?? "");
    const jobType = String(row.jobType ?? "");
    if (!bucket || !jobType) {
      continue;
    }
    const target =
      byBucket.get(bucket) ??
      ({
        bucket,
        bucketLabel: formatBucketLabel(bucket),
      } satisfies Record<string, string | number | null>);
    const rawValue = row[valueKey];
    target[jobType] =
      typeof rawValue === "number" && Number.isFinite(rawValue)
        ? Math.round(rawValue)
        : null;
    byBucket.set(bucket, target);
  }
  return [...byBucket.values()].sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  );
}

function formatBucketLabel(bucket: string): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) {
    return bucket;
  }
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(value: number | null | undefined): string {
  if (!Number.isFinite(value ?? NaN)) {
    return "-";
  }
  return formatSeconds(Math.max(0, Math.floor((value ?? 0) / 1000)));
}

function formatSeconds(value: number | null | undefined): string {
  if (!Number.isFinite(value ?? NaN)) {
    return "-";
  }
  const seconds = Math.max(0, Math.floor(value ?? 0));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}
