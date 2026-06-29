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
  type AdminEnvironment,
  getDefaultAdminEnvironment,
  useAdminContext,
} from "./adminUtils";

type RealtimeOverview = {
  environment: string;
  recentMinutes?: number;
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
  window: RealtimeWindow;
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

type RealtimeWindow = "15m" | "1h" | "6h" | "24h";

const REFRESH_MS = 10_000;
const WINDOW_OPTIONS: Array<{ value: RealtimeWindow; label: string; minutes: number }> =
  [
    { value: "15m", label: "近 15 分钟", minutes: 15 },
    { value: "1h", label: "近 1 小时", minutes: 60 },
    { value: "6h", label: "近 6 小时", minutes: 360 },
    { value: "24h", label: "近 24 小时", minutes: 1440 },
  ];

export default function AdminRealtimePage() {
  const { password } = useAdminContext();
  const [environment, setEnvironment] = useState<AdminEnvironment>(() =>
    getDefaultAdminEnvironment(),
  );
  const [data, setData] = useState<RealtimeOverview | null>(null);
  const [workerGroups, setWorkerGroups] =
    useState<RealtimeWorkerGroups | null>(null);
  const [recentWindow, setRecentWindow] = useState<RealtimeWindow>("1h");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    try {
      const headers = { "x-api-secret": password };
      const recentMinutes = getWindowMinutes(recentWindow);
      const [overviewRes, workerGroupsRes] = await Promise.all([
        fetch(
          `/api/v1/admin/realtime/overview?env=${environment}&recentMinutes=${recentMinutes}`,
          { headers },
        ),
        fetch(
          `/api/v1/admin/realtime/worker-groups?env=${environment}&window=${recentWindow}`,
          { headers },
        ),
      ]);
      if (overviewRes.ok) {
        setData((await overviewRes.json()) as RealtimeOverview);
      }
      if (workerGroupsRes.ok) {
        setWorkerGroups((await workerGroupsRes.json()) as RealtimeWorkerGroups);
      }
    } finally {
      setLoading(false);
    }
  }, [environment, password, recentWindow]);

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
          <Select
            label="最近窗口"
            size="xs"
            value={recentWindow}
            onChange={(value) => setRecentWindow(parseRealtimeWindow(value))}
            data={WINDOW_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            w={130}
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

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <MetricCard
          label="ClickHouse"
          value={clickhouse?.ping ? "正常" : clickhouse?.enabled ? "异常" : "关闭"}
          color={clickhouse?.ping ? "green" : clickhouse?.enabled ? "red" : "gray"}
        />
        <MetricCard
          label="ClickHouse 写入缓冲"
          value={`${clickhouse?.bufferedRows ?? 0} 待写 / ${
            clickhouse?.droppedRows ?? 0
          } 丢弃`}
          color={(clickhouse?.droppedRows ?? 0) > 0 ? "red" : "blue"}
        />
        <MetricCard
          label="今日外部调用类型"
          value={String(data?.usageToday?.length ?? 0)}
          color={(data?.usageToday?.length ?? 0) > 0 ? "blue" : "gray"}
        />
        <MetricCard
          label="最近错误类型"
          value={String(
            (data?.recentErrors?.http?.length ?? 0) +
              (data?.recentErrors?.externalApi?.length ?? 0),
          )}
          color={
            (data?.recentErrors?.http?.length ?? 0) +
              (data?.recentErrors?.externalApi?.length ?? 0) >
            0
              ? "red"
              : "gray"
          }
        />
      </SimpleGrid>

      {clickhouse?.lastError && (
        <Card withBorder>
          <Text c="red" size="sm">
            ClickHouse 最近错误：{clickhouse.lastError}
          </Text>
        </Card>
      )}

      <WorkerOverviewCard groups={workerGroups?.groups ?? []} />

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <RowsCard title="最近 15 分钟 HTTP 5xx" rows={data?.recentErrors?.http} />
        <RowsCard
          title="最近 15 分钟外部调用错误"
          rows={data?.recentErrors?.externalApi}
        />
      </SimpleGrid>

      <Tabs defaultValue="dxnet" keepMounted={false}>
        <Group justify="space-between" align="flex-end" mb="sm">
          <Tabs.List>
            <Tabs.Tab value="dxnet">DXNet 详情</Tabs.Tab>
            <Tabs.Tab value="sdgb">SDGB 详情</Tabs.Tab>
            <Tabs.Tab value="prober_export">查分器导出详情</Tabs.Tab>
          </Tabs.List>
          <Text size="xs" c="dimmed">
            详情趋势跟随最近窗口：{formatWindowLabel(recentWindow)}
          </Text>
        </Group>

        {(["dxnet", "sdgb", "prober_export"] as WorkerKind[]).map((kind) => (
          <Tabs.Panel key={kind} value={kind}>
            <WorkerMonitorPanel
              group={workerGroups?.groups.find(
                (candidate) => candidate.workerKind === kind,
              )}
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

function WorkerOverviewCard({ groups }: { groups: WorkerGroup[] }) {
  const rows = (["dxnet", "sdgb", "prober_export"] as WorkerKind[]).map(
    (kind) =>
      summarizeWorkerGroup(
        groups.find((candidate) => candidate.workerKind === kind),
        kind,
      ),
  );

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Title order={4}>Worker 总览</Title>
        <Text size="xs" c="dimmed">
          一眼看异常：错误、积压、成功率和耗时
        </Text>
      </Group>
      <Table.ScrollContainer minWidth={860}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Worker</Table.Th>
              <Table.Th>状态</Table.Th>
              <Table.Th>实例</Table.Th>
              <Table.Th>排队 / 处理</Table.Th>
              <Table.Th>最近成功 / 失败</Table.Th>
              <Table.Th>最近成功率</Table.Th>
              <Table.Th>p95 耗时</Table.Th>
              <Table.Th>最近错误</Table.Th>
              <Table.Th>活跃任务</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.kind}>
                <Table.Td>{row.title}</Table.Td>
                <Table.Td>
                  <Badge color={row.color} variant="light">
                    {row.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{row.workerCount}</Table.Td>
                <Table.Td>
                  {row.queued} / {row.processing}
                </Table.Td>
                <Table.Td>
                  {row.recentSuccess} / {row.recentFailed}
                </Table.Td>
                <Table.Td>
                  <Badge color={row.successRateColor} variant="light">
                    {row.successRateLabel}
                  </Badge>
                </Table.Td>
                <Table.Td>{row.p95Label}</Table.Td>
                <Table.Td>
                  <Badge color={row.errorCount > 0 ? "red" : "gray"} variant="light">
                    {row.errorCount}
                  </Badge>
                </Table.Td>
                <Table.Td>{row.activeCount}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function summarizeWorkerGroup(group: WorkerGroup | undefined, kind: WorkerKind) {
  const title =
    kind === "dxnet"
      ? "DXNet"
      : kind === "sdgb"
        ? "SDGB"
        : "查分器导出";
  if (!group) {
    return {
      kind,
      title,
      status: "无数据",
      color: "gray",
      workerCount: 0,
      queued: 0,
      processing: 0,
      successRateLabel: "-",
      successRateColor: "gray",
      recentSuccess: 0,
      recentFailed: 0,
      p95Label: "-",
      errorCount: 0,
      activeCount: 0,
    };
  }
  const queued = sumQueue(group.queueByJobType, "queued");
  const processing = sumQueue(group.queueByJobType, "processing");
  const errorCount = group.recentErrors.reduce((sum, row) => sum + row.count, 0);
  const successTotals = group.successRateTrend.reduce(
    (acc, row) => ({
      completed: acc.completed + row.completed,
      failed: acc.failed + row.failed,
      total: acc.total + row.total,
    }),
    { completed: 0, failed: 0, total: 0 },
  );
  const successRate =
    successTotals.total > 0
      ? Math.round((successTotals.completed / successTotals.total) * 100)
      : null;
  const p95Values = group.durationTrend
    .map((row) => row.p95Ms)
    .filter((value): value is number => typeof value === "number");
  const maxP95 = p95Values.length ? Math.max(...p95Values) : null;
  const status =
    errorCount > 0
      ? "异常"
      : queued > 0
        ? "积压"
        : processing > 0
          ? "处理中"
          : "正常";
  const color =
    errorCount > 0 ? "red" : queued > 0 ? "yellow" : processing > 0 ? "blue" : "green";

  return {
    kind,
    title,
    status,
    color,
    workerCount: group.workers.length,
    queued,
    processing,
    successRateLabel: successRate === null ? "-" : `${successRate}%`,
    successRateColor:
      successRate === null
        ? "gray"
        : successRate >= 95
          ? "green"
          : successRate >= 80
            ? "yellow"
            : "red",
    recentSuccess: successTotals.completed,
    recentFailed: successTotals.failed,
    p95Label: maxP95 === null ? "-" : formatDuration(maxP95),
    errorCount,
    activeCount: group.activeJobs.length,
  };
}

function WorkerMonitorPanel({
  group,
}: {
  group: WorkerGroup | undefined;
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
      <Stack gap={0}>
        <Title order={3}>{group.title}</Title>
        <Text size="sm" c="dimmed">
          按 job type 展示队列、活跃任务、成功率趋势、耗时趋势和最近错误
        </Text>
      </Stack>

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

      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <ActiveWorkerJobsCard jobs={group.activeJobs} />
        <RecentErrorsCard rows={group.recentErrors} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <TrendCard
          title="成功率趋势"
          data={group.successRateTrend}
          valueKey="successRate"
          valueLabel="成功率 %"
          unit="%"
        />
        <CountTrendCard data={group.successRateTrend} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, xl: 2 }}>
        <TrendCard
          title="耗时趋势 p95"
          data={group.durationTrend}
          valueKey="p95Ms"
          valueLabel="p95 耗时"
          unit="ms"
        />
      </SimpleGrid>
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
                      <Badge color={isWorkerAlive(row.lastSeenAt) ? "green" : "red"} variant="light">
                        {isWorkerAlive(row.lastSeenAt) ? "在线" : "离线"}
                      </Badge>
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

function CountTrendCard({ data }: { data: SuccessRateTrendPoint[] }) {
  const completed = toChartData(data, "completed").map((row) => ({
    ...prefixChartKeys(row, "成功 "),
  }));
  const failed = toChartData(data, "failed").map((row) => ({
    ...prefixChartKeys(row, "失败 "),
  }));
  const byBucket = new Map<string, Record<string, string | number | null>>();
  for (const row of [...completed, ...failed]) {
    const bucket = String(row.bucket);
    byBucket.set(bucket, { ...(byBucket.get(bucket) ?? {}), ...row });
  }
  const chartData = [...byBucket.values()].sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  );
  const keys = Array.from(
    new Set(
      chartData.flatMap((row) =>
        Object.keys(row).filter((key) => key !== "bucket" && key !== "bucketLabel"),
      ),
    ),
  );
  const colors = ["#40c057", "#fa5252", "#228be6", "#fab005", "#7950f2", "#15aabf"];

  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        成功 / 失败数量趋势
      </Title>
      {!chartData.length || !keys.length ? (
        <Text size="sm" c="dimmed">
          暂无数量趋势数据
        </Text>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="bucketLabel" minTickGap={24} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            {keys.map((key, index) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
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

function prefixChartKeys(
  row: Record<string, string | number | null>,
  prefix: string,
): Record<string, string | number | null> {
  const next: Record<string, string | number | null> = {
    bucket: row.bucket,
    bucketLabel: row.bucketLabel,
  };
  for (const [key, value] of Object.entries(row)) {
    if (key !== "bucket" && key !== "bucketLabel") {
      next[`${prefix}${key}`] = value;
    }
  }
  return next;
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

function parseRealtimeWindow(value: string | null): RealtimeWindow {
  return value === "15m" || value === "6h" || value === "24h" ? value : "1h";
}

function getWindowMinutes(value: RealtimeWindow): number {
  return WINDOW_OPTIONS.find((option) => option.value === value)?.minutes ?? 60;
}

function formatWindowLabel(value: RealtimeWindow): string {
  return WINDOW_OPTIONS.find((option) => option.value === value)?.label ?? value;
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

function isWorkerAlive(value: unknown): boolean {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time < 5 * 60 * 1000;
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
