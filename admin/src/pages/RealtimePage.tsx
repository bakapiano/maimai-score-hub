import { Button, Card, Tabs, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DynamicTable } from "../components/DynamicTable";
import { LazyLineChart } from "../components/LazyLineChart";
import { MetricCard } from "../components/MetricCard";
import { PageHeader } from "../components/PageHeader";
import { ResponsiveTable } from "../components/ResponsiveTable";
import { adminFetch } from "../api/client";
import {
  type RealtimeWindow,
  formatDuration,
  formatSeconds,
  formatTime,
  useAdminContext,
} from "../utils/admin";

const { Text, Title } = Typography;

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

const REFRESH_MS = 10_000;
const WINDOW_OPTIONS: Array<{
  value: RealtimeWindow;
  label: string;
  minutes: number;
}> = [
  { value: "15m", label: "近 15 分钟", minutes: 15 },
  { value: "1h", label: "近 1 小时", minutes: 60 },
  { value: "6h", label: "近 6 小时", minutes: 360 },
  { value: "24h", label: "近 24 小时", minutes: 1440 },
];

export default function RealtimePage() {
  const { password, environment, realtimeWindow } = useAdminContext();
  const [data, setData] = useState<RealtimeOverview | null>(null);
  const [workerGroups, setWorkerGroups] =
    useState<RealtimeWorkerGroups | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeWorkerKind, setActiveWorkerKind] =
    useState<WorkerKind>("dxnet");
  const loadInFlight = useRef(false);

  const load = useCallback(async () => {
    if (!password) return;
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    setLoading(true);
    try {
      const recentMinutes = getWindowMinutes(realtimeWindow);
      const [overview, groups] = await Promise.all([
        adminFetch<RealtimeOverview>(
          environment,
          "/admin/realtime/overview",
          password,
          {
            env: environment,
            recentMinutes,
          },
        ),
        adminFetch<RealtimeWorkerGroups>(
          environment,
          "/admin/realtime/worker-groups",
          password,
          {
            env: environment,
            window: realtimeWindow,
          },
        ),
      ]);
      setData(overview);
      setWorkerGroups(groups);
    } finally {
      loadInFlight.current = false;
      setLoading(false);
    }
  }, [environment, password, realtimeWindow]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const clickhouse = data?.system?.clickhouse;

  return (
    <div className="page-stack">
      <PageHeader
        title="实时监控"
        description="当前健康状态、Bot 可用性、实时任务、队列和最近错误。"
        extra={
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => void load()}
            loading={loading}
          >
            刷新
          </Button>
        }
      />

      <div className="metric-grid">
        <MetricCard
          title="ClickHouse"
          value={clickhouse?.ping ? "正常" : clickhouse?.enabled ? "异常" : "关闭"}
          status={clickhouse?.ping ? "OK" : clickhouse?.enabled ? "ERROR" : "OFF"}
          color={clickhouse?.ping ? "green" : clickhouse?.enabled ? "red" : "default"}
        />
        <MetricCard
          title="ClickHouse 写入缓冲"
          value={`${clickhouse?.bufferedRows ?? 0} / ${clickhouse?.droppedRows ?? 0}`}
          status="待写 / 丢弃"
          color={(clickhouse?.droppedRows ?? 0) > 0 ? "red" : "blue"}
        />
        <MetricCard
          title="今日外部调用类型"
          value={data?.usageToday?.length ?? 0}
          status="types"
          color={(data?.usageToday?.length ?? 0) > 0 ? "blue" : "default"}
        />
        <MetricCard
          title="最近错误类型"
          value={
            (data?.recentErrors?.http?.length ?? 0) +
            (data?.recentErrors?.externalApi?.length ?? 0)
          }
          status="15m"
          color={
            (data?.recentErrors?.http?.length ?? 0) +
              (data?.recentErrors?.externalApi?.length ?? 0) >
            0
              ? "red"
              : "default"
          }
        />
      </div>

      {clickhouse?.lastError ? (
        <Card className="admin-card">
          <Text type="danger">ClickHouse 最近错误：{clickhouse.lastError}</Text>
        </Card>
      ) : null}

      <WorkerOverviewCard groups={workerGroups?.groups ?? []} />

      <div className="panel-grid-2">
        <Card className="admin-card" title="最近 15 分钟 HTTP 5xx">
          <DynamicTable rows={data?.recentErrors?.http ?? []} />
        </Card>
        <Card className="admin-card" title="最近 15 分钟外部调用错误">
          <DynamicTable rows={data?.recentErrors?.externalApi ?? []} />
        </Card>
      </div>

      <Card className="admin-card">
        <Tabs
          destroyOnHidden
          activeKey={activeWorkerKind}
          onChange={(key) => setActiveWorkerKind(key as WorkerKind)}
          items={(["dxnet", "sdgb", "prober_export"] as WorkerKind[]).map(
            (kind) => ({
              key: kind,
              label:
                kind === "dxnet"
                  ? "DXNet 详情"
                  : kind === "sdgb"
                    ? "SDGB 详情"
                    : "查分器导出详情",
              children: kind === activeWorkerKind ? (
                <WorkerMonitorPanel
                  group={workerGroups?.groups.find(
                    (candidate) => candidate.workerKind === kind,
                  )}
                />
              ) : null,
            }),
          )}
        />
      </Card>
    </div>
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

  const columns = [
    { title: "Worker", dataIndex: "title", key: "title", width: 140 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: string, row: ReturnType<typeof summarizeWorkerGroup>) => (
        <Tag color={row.color}>{value}</Tag>
      ),
    },
    { title: "实例", dataIndex: "workerCount", key: "workerCount", width: 80 },
    {
      title: "排队 / 处理",
      key: "queue",
      width: 120,
      render: (_: unknown, row: ReturnType<typeof summarizeWorkerGroup>) =>
        `${row.queued} / ${row.processing}`,
    },
    {
      title: "最近成功 / 失败",
      key: "success",
      width: 140,
      render: (_: unknown, row: ReturnType<typeof summarizeWorkerGroup>) =>
        `${row.recentSuccess} / ${row.recentFailed}`,
    },
    {
      title: "成功率",
      dataIndex: "successRateLabel",
      key: "successRateLabel",
      width: 110,
      render: (value: string, row: ReturnType<typeof summarizeWorkerGroup>) => (
        <Tag color={row.successRateColor}>{value}</Tag>
      ),
    },
    { title: "p95 耗时", dataIndex: "p95Label", key: "p95Label", width: 110 },
    { title: "最近错误", dataIndex: "errorCount", key: "errorCount", width: 100 },
    { title: "活跃任务", dataIndex: "activeCount", key: "activeCount", width: 100 },
  ];

  return (
    <Card className="admin-card wide-table-card" title="Worker 总览">
      <ResponsiveTable
        rowKey="kind"
        size="middle"
        columns={columns}
        dataSource={rows}
        pagination={false}
        renderMobileItem={(row) => (
          <MobileFields
            title={row.title}
            fields={[
              ["状态", <Tag color={row.color}>{row.status}</Tag>],
              ["实例", row.workerCount],
              ["排队 / 处理", `${row.queued} / ${row.processing}`],
              ["最近成功 / 失败", `${row.recentSuccess} / ${row.recentFailed}`],
              ["成功率", <Tag color={row.successRateColor}>{row.successRateLabel}</Tag>],
              ["p95 耗时", row.p95Label],
              ["最近错误", row.errorCount],
              ["活跃任务", row.activeCount],
            ]}
          />
        )}
      />
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
      color: "default",
      workerCount: 0,
      queued: 0,
      processing: 0,
      successRateLabel: "-",
      successRateColor: "default",
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
    errorCount > 0 ? "red" : queued > 0 ? "gold" : processing > 0 ? "blue" : "green";

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
        ? "default"
        : successRate >= 95
          ? "green"
          : successRate >= 80
            ? "gold"
            : "red",
    recentSuccess: successTotals.completed,
    recentFailed: successTotals.failed,
    p95Label: maxP95 === null ? "-" : formatDuration(maxP95),
    errorCount,
    activeCount: group.activeJobs.length,
  };
}

function WorkerMonitorPanel({ group }: { group: WorkerGroup | undefined }) {
  if (!group) {
    return <Text type="secondary">暂无 worker 数据</Text>;
  }

  return (
    <div className="page-stack">
      <div>
        <Title level={3} style={{ marginBottom: 4 }}>
          {group.title}
        </Title>
        <Text type="secondary">
          按 job type 展示队列、活跃任务、成功率趋势、耗时趋势和最近错误。
        </Text>
      </div>

      <div className="metric-grid">
        <MetricCard title="Worker 实例" value={group.workers.length} status="live" />
        <MetricCard
          title="排队中"
          value={sumQueue(group.queueByJobType, "queued")}
          color={sumQueue(group.queueByJobType, "queued") > 0 ? "gold" : "default"}
          status="queued"
        />
        <MetricCard
          title="处理中"
          value={sumQueue(group.queueByJobType, "processing")}
          color={sumQueue(group.queueByJobType, "processing") > 0 ? "blue" : "default"}
          status="processing"
        />
        <MetricCard
          title="最近错误"
          value={group.recentErrors.reduce((sum, row) => sum + row.count, 0)}
          color={group.recentErrors.length > 0 ? "red" : "default"}
          status="errors"
        />
      </div>

      <div className="panel-grid-2">
        <QueueByJobTypeTable rows={group.queueByJobType} />
        <WorkerInstancesTable rows={group.workers} />
      </div>

      <div className="panel-grid-2">
        <ActiveWorkerJobsTable jobs={group.activeJobs} />
        <RecentErrorsTable rows={group.recentErrors} />
      </div>

      <div className="panel-grid-2">
        <TrendCard
          title="成功率趋势"
          data={group.successRateTrend}
          valueKey="successRate"
          unit="%"
        />
        <CountTrendCard data={group.successRateTrend} />
      </div>

      <div className="panel-grid-2">
        <TrendCard
          title="耗时趋势 p95"
          data={group.durationTrend}
          valueKey="p95Ms"
          unit="ms"
        />
      </div>
    </div>
  );
}

function QueueByJobTypeTable({ rows }: { rows: QueueByJobType[] }) {
  const columns = [
    { title: "Job type", dataIndex: "jobType", key: "jobType", width: 220 },
    { title: "排队", dataIndex: "queued", key: "queued", width: 80 },
    { title: "处理", dataIndex: "processing", key: "processing", width: 80 },
    { title: "失败", dataIndex: "failed", key: "failed", width: 80 },
    { title: "完成", dataIndex: "completed", key: "completed", width: 80 },
    {
      title: "最久排队",
      dataIndex: "oldestQueuedAgeSeconds",
      key: "oldestQueuedAgeSeconds",
      width: 120,
      render: (value: number | null) => formatSeconds(value),
    },
  ];

  return (
    <Card className="admin-card wide-table-card" title="按类型队列">
      <ResponsiveTable
        size="small"
        rowKey="jobType"
        columns={columns}
        dataSource={rows}
        pagination={false}
        renderMobileItem={(row) => (
          <MobileFields
            title={row.jobType}
            fields={[
              ["排队", row.queued],
              ["处理", row.processing],
              ["失败", row.failed],
              ["完成", row.completed],
              ["最久排队", formatSeconds(row.oldestQueuedAgeSeconds)],
            ]}
          />
        )}
      />
    </Card>
  );
}

function WorkerInstancesTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = [
    {
      title: "workerId",
      key: "workerId",
      width: 220,
      render: (row: Record<string, unknown>) => (
        <Text className="cell-monospace">
          {String(row.workerId ?? row.botFriendCode ?? "-")}
        </Text>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 100,
      render: (row: Record<string, unknown>) =>
        "available" in row ? (
          <Tag color={row.available ? "green" : "red"}>
            {row.available ? "可用" : "不可用"}
          </Tag>
        ) : (
          <Tag color={isWorkerAlive(row) ? "green" : "red"}>
            {isWorkerAlive(row) ? "在线" : "离线"}
          </Tag>
        ),
    },
    {
      title: "最近上报",
      key: "lastSeenAt",
      width: 120,
      render: (row: Record<string, unknown>) =>
        formatTime(String(row.lastSeenAt ?? "")),
    },
    {
      title: "信息",
      key: "info",
      width: 260,
      render: (row: Record<string, unknown>) => formatWorkerInfo(row),
    },
  ];

  return (
    <Card className="admin-card wide-table-card" title="Worker 实例">
      <ResponsiveTable
        size="small"
        rowKey={(row, index) => `${String(row.workerId ?? index)}-${index}`}
        columns={columns}
        dataSource={rows}
        pagination={false}
        renderMobileItem={(row) => (
          <MobileFields
            title={String(row.workerId ?? row.botFriendCode ?? "-")}
            fields={[
              [
                "状态",
                "available" in row ? (
                  <Tag color={row.available ? "green" : "red"}>
                    {row.available ? "可用" : "不可用"}
                  </Tag>
                ) : (
                  <Tag color={isWorkerAlive(row) ? "green" : "red"}>
                    {isWorkerAlive(row) ? "在线" : "离线"}
                  </Tag>
                ),
              ],
              ["最近上报", formatTime(String(row.lastSeenAt ?? ""))],
              ["信息", formatWorkerInfo(row)],
            ]}
          />
        )}
      />
    </Card>
  );
}

function ActiveWorkerJobsTable({ jobs }: { jobs: WorkerActiveJob[] }) {
  const columns = [
    {
      title: "Job",
      dataIndex: "id",
      key: "id",
      width: 100,
      render: (value: string) => (
        <Text className="cell-monospace">{value.slice(0, 8)}</Text>
      ),
    },
    { title: "Job type", dataIndex: "jobType", key: "jobType", width: 180 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (value: string) => (
        <Tag color={value === "processing" ? "blue" : "gold"}>{value}</Tag>
      ),
    },
    { title: "阶段", dataIndex: "stage", key: "stage", width: 160 },
    {
      title: "Worker/Bot",
      key: "worker",
      width: 180,
      render: (row: WorkerActiveJob) => row.workerId ?? row.botFriendCode ?? "-",
    },
    { title: "用户", dataIndex: "friendCode", key: "friendCode", width: 140 },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 100,
      render: (value: number) => formatDuration(value),
    },
  ];

  return (
    <Card className="admin-card wide-table-card" title="活跃任务">
      <ResponsiveTable
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={jobs}
        pagination={false}
        renderMobileItem={(job) => (
          <MobileFields
            title={job.id.slice(0, 8)}
            fields={[
              ["Job type", job.jobType],
              [
                "状态",
                <Tag color={job.status === "processing" ? "blue" : "gold"}>
                  {job.status}
                </Tag>,
              ],
              ["阶段", job.stage ?? "-"],
              ["Worker/Bot", job.workerId ?? job.botFriendCode ?? "-"],
              ["用户", job.friendCode ?? "-"],
              ["耗时", formatDuration(job.durationMs)],
            ]}
          />
        )}
      />
    </Card>
  );
}

function RecentErrorsTable({ rows }: { rows: RecentWorkerError[] }) {
  const columns = [
    { title: "Job type", dataIndex: "jobType", key: "jobType", width: 180 },
    {
      title: "错误类型",
      dataIndex: "errorClass",
      key: "errorClass",
      width: 160,
      render: (value: string) => <Tag color="red">{value}</Tag>,
    },
    { title: "消息", dataIndex: "message", key: "message", width: 320 },
    { title: "次数", dataIndex: "count", key: "count", width: 80 },
  ];

  return (
    <Card className="admin-card wide-table-card" title="最近错误">
      <ResponsiveTable
        size="small"
        rowKey={(row, index) => `${row.jobType}-${row.errorClass}-${index}`}
        columns={columns}
        dataSource={rows}
        pagination={false}
        renderMobileItem={(row) => (
          <MobileFields
            title={row.jobType}
            fields={[
              ["错误类型", <Tag color="red">{row.errorClass}</Tag>],
              ["消息", row.message],
              ["次数", row.count],
            ]}
          />
        )}
      />
    </Card>
  );
}

function TrendCard({
  title,
  data,
  valueKey,
  unit,
}: {
  title: string;
  data: Array<Record<string, unknown>>;
  valueKey: string;
  unit: string;
}) {
  const chartData = useMemo(() => toChartRows(data, valueKey), [data, valueKey]);

  return (
    <Card className="admin-card" title={title}>
      {chartData.length ? (
        <LazyLineChart
          data={chartData}
          xField="bucketLabel"
          yField="value"
          colorField="series"
          height={260}
          autoFit
          point={{ sizeField: 3 }}
          axis={{
            y: { labelFormatter: (value: number) => `${value}${unit}` },
          }}
          tooltip={{
            title: "bucketLabel",
            items: [
              {
                channel: "y",
                valueFormatter: (value: number) => `${value}${unit}`,
              },
            ],
          }}
        />
      ) : (
        <Text type="secondary">暂无趋势数据</Text>
      )}
    </Card>
  );
}

function CountTrendCard({ data }: { data: SuccessRateTrendPoint[] }) {
  const chartData = useMemo(
    () => [
      ...toChartRows(data, "completed", "成功"),
      ...toChartRows(data, "failed", "失败"),
    ],
    [data],
  );

  return (
    <Card className="admin-card" title="成功 / 失败数量趋势">
      {chartData.length ? (
        <LazyLineChart
          data={chartData}
          xField="bucketLabel"
          yField="value"
          colorField="series"
          height={260}
          autoFit
          point={{ sizeField: 3 }}
        />
      ) : (
        <Text type="secondary">暂无数量趋势数据</Text>
      )}
    </Card>
  );
}

function toChartRows(
  rows: Array<Record<string, unknown>>,
  valueKey: string,
  prefix = "",
) {
  return rows
    .map((row) => {
      const bucket = String(row.bucket ?? "");
      const jobType = String(row.jobType ?? "");
      const rawValue = row[valueKey];
      const value =
        typeof rawValue === "number" && Number.isFinite(rawValue)
          ? Math.round(rawValue)
          : null;
      if (!bucket || !jobType || value === null) {
        return null;
      }
      return {
        bucket,
        bucketLabel: formatBucketLabel(bucket),
        series: prefix ? `${prefix} ${jobType}` : jobType,
        value,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function getWindowMinutes(value: RealtimeWindow): number {
  return WINDOW_OPTIONS.find((option) => option.value === value)?.minutes ?? 60;
}

function sumQueue(
  rows: QueueByJobType[],
  key: "queued" | "processing" | "failed" | "completed",
): number {
  return rows.reduce((sum, row) => sum + row[key], 0);
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

function isWorkerAlive(row: Record<string, unknown>): boolean {
  if (row.alive === true) {
    return true;
  }
  const value = row.lastSeenAt;
  if (typeof value !== "string" || !value) {
    return false;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time < 5 * 60 * 1000;
}

function MobileFields({
  title,
  fields,
}: {
  title: ReactNode;
  fields: Array<[string, ReactNode]>;
}) {
  return (
    <div className="mobile-fields">
      <Text strong className="mobile-card-title">
        {title}
      </Text>
      {fields.map(([label, value]) => (
        <div className="mobile-field" key={label}>
          <Text type="secondary">{label}</Text>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}
