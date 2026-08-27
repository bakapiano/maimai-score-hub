import { ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Empty,
  Segmented,
  Space,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { adminFetch } from "../api/client";
import { LazyLineChart } from "../components/LazyLineChart";
import { MetricCard } from "../components/MetricCard";
import { PageHeader } from "../components/PageHeader";
import { ResponsiveTable } from "../components/ResponsiveTable";
import { formatDateTime, formatDuration, useAdminContext } from "../utils/admin";

const { Text } = Typography;

type AutoUpdateProject = "fcfs" | "settled" | "daily";
type AutoUpdateWindow = "6h" | "24h" | "7d";

type AutoUpdateMetric = {
  project: AutoUpdateProject;
  label: string;
  pending: number;
  p50Ms: number;
  p95Ms: number;
  completePerMinute: number;
  drainEtaMinutes: number | null;
  recentFailures: number;
};

type AutoUpdateTrendPoint = Omit<AutoUpdateMetric, "label"> & {
  bucket: string;
};

type AutoUpdateOverview = {
  environment: string;
  generatedAt: string;
  window: AutoUpdateWindow;
  enabledUsers: number;
  projects: AutoUpdateMetric[];
  trend: AutoUpdateTrendPoint[];
};

const PROJECT_LABELS: Record<AutoUpdateProject, string> = {
  fcfs: "FC/FS",
  settled: "Settled",
  daily: "Daily",
};

export default function AutoUpdatePage() {
  const { password, environment } = useAdminContext();
  const [range, setRange] = useState<AutoUpdateWindow>("6h");
  const [project, setProject] = useState<AutoUpdateProject>("fcfs");
  const [data, setData] = useState<AutoUpdateOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    try {
      setData(
        await adminFetch<AutoUpdateOverview>(
          environment,
          "/admin/auto-update/overview",
          password,
          { env: environment, window: range },
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [environment, password, range]);

  useEffect(() => {
    void load();
    const timer = range === "6h" ? windowSetInterval(load, 30_000) : null;
    return () => {
      if (timer !== null) globalThis.clearInterval(timer);
    };
  }, [load, range]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Auto Update"
        description={
          data
            ? `每分钟采样 · 更新于 ${formatDateTime(data.generatedAt)}`
            : "查看各项目积压、Queue 延迟与消化速度。"
        }
        extra={
          <Space wrap>
            <Segmented<AutoUpdateWindow>
              value={range}
              onChange={setRange}
              options={["6h", "24h", "7d"]}
            />
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void load()}
            >
              刷新
            </Button>
          </Space>
        }
      />

      {error ? <Alert showIcon type="error" message={error} /> : null}

      <div className="auto-update-metric-grid">
        <MetricCard title="开启人数" value={data?.enabledUsers ?? "-"} />
      </div>

      <PressureTable rows={data?.projects ?? []} loading={loading} />
      <QueueTrendCard
        rows={data?.trend ?? []}
        project={project}
        onProjectChange={setProject}
      />
    </div>
  );
}

function PressureTable({
  rows,
  loading,
}: {
  rows: AutoUpdateMetric[];
  loading: boolean;
}) {
  const columns = [
    {
      title: "项目",
      dataIndex: "label",
      key: "label",
      width: 150,
      render: (value: string, row: AutoUpdateMetric) => (
        <Space size={8} wrap>
          <Text strong>{value}</Text>
          <PressureTag row={row} />
        </Space>
      ),
    },
    { title: "Pending", dataIndex: "pending", key: "pending", width: 110 },
    {
      title: "Queue p50 / p95",
      key: "queuePercentiles",
      width: 190,
      render: (_: unknown, row: AutoUpdateMetric) =>
        `${formatQueueDuration(row.p50Ms, row.pending)} / ${formatQueueDuration(row.p95Ms, row.pending)}`,
    },
    {
      title: "Complete/min",
      dataIndex: "completePerMinute",
      key: "completePerMinute",
      width: 130,
      render: (value: number) => formatRate(value),
    },
    {
      title: "ETA",
      dataIndex: "drainEtaMinutes",
      key: "drainEtaMinutes",
      width: 120,
      render: (value: number | null, row: AutoUpdateMetric) =>
        formatEta(value, row.pending),
    },
  ];

  return (
    <Card className="admin-card wide-table-card" title="项目压力">
      <ResponsiveTable
        rowKey="project"
        columns={columns}
        dataSource={rows}
        pagination={false}
        loading={loading && rows.length === 0}
        renderMobileItem={(row) => (
          <MobileFields
            title={
              <Space size={8} wrap>
                {row.label}
                <PressureTag row={row} />
              </Space>
            }
            fields={[
              ["Pending", row.pending],
              [
                "Queue p50 / p95",
                `${formatQueueDuration(row.p50Ms, row.pending)} / ${formatQueueDuration(row.p95Ms, row.pending)}`,
              ],
              ["Complete/min", formatRate(row.completePerMinute)],
              ["ETA", formatEta(row.drainEtaMinutes, row.pending)],
            ]}
          />
        )}
      />
    </Card>
  );
}

function QueueTrendCard({
  rows,
  project,
  onProjectChange,
}: {
  rows: AutoUpdateTrendPoint[];
  project: AutoUpdateProject;
  onProjectChange: (value: AutoUpdateProject) => void;
}) {
  const chartData = useMemo(
    () =>
      rows
        .filter((row) => row.project === project)
        .flatMap((row) => [
          toChartPoint(row, "p50", row.p50Ms),
          toChartPoint(row, "p95", row.p95Ms),
        ]),
    [project, rows],
  );

  return (
    <Card
      className="admin-card"
      title="Queue 延迟趋势"
      extra={
        <Segmented<AutoUpdateProject>
          value={project}
          onChange={onProjectChange}
          options={(Object.keys(PROJECT_LABELS) as AutoUpdateProject[]).map(
            (key) => ({ value: key, label: PROJECT_LABELS[key] }),
          )}
        />
      }
    >
      {chartData.length ? (
        <LazyLineChart
          data={chartData}
          xField="bucketLabel"
          yField="value"
          colorField="series"
          height={320}
          autoFit
          point={{ sizeField: 2 }}
          scale={{
            color: {
              domain: ["p50", "p95"],
              range: ["#1677ff", "#f97316"],
            },
          }}
          axis={{ y: { labelFormatter: formatDuration } }}
          tooltip={{
            title: "bucketLabel",
            items: [
              {
                channel: "y",
                valueFormatter: formatDuration,
              },
              { field: "pending", name: "Pending" },
              {
                field: "completePerMinute",
                name: "Complete/min",
                valueFormatter: formatRate,
              },
            ],
          }}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无趋势数据" />
      )}
    </Card>
  );
}

function PressureTag({ row }: { row: AutoUpdateMetric }) {
  if (row.recentFailures > 0) {
    return <Tag color="red">失败 {row.recentFailures}</Tag>;
  }
  if (row.pending > 0 && row.drainEtaMinutes === null) {
    return <Tag color="gold">待估算</Tag>;
  }
  if ((row.drainEtaMinutes ?? 0) > 60) {
    return <Tag color="red">高压</Tag>;
  }
  if ((row.drainEtaMinutes ?? 0) > 30) {
    return <Tag color="orange">偏高</Tag>;
  }
  return <Tag color="green">正常</Tag>;
}

function toChartPoint(
  row: AutoUpdateTrendPoint,
  series: "p50" | "p95",
  value: number,
) {
  return {
    bucket: row.bucket,
    bucketLabel: formatBucketLabel(row.bucket),
    series,
    value,
    pending: row.pending,
    completePerMinute: row.completePerMinute,
  };
}

function formatBucketLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatQueueDuration(value: number, pending: number) {
  return value === 0 && pending === 0 ? "-" : formatDuration(value);
}

function formatRate(value: number) {
  if (!Number.isFinite(value)) return "-";
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function formatEta(value: number | null, pending: number) {
  if (pending === 0) return "0m";
  if (value === null) return "计算中";
  if (value < 60) return `${Math.ceil(value)}m`;
  return `${(value / 60).toFixed(1)}h`;
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

function windowSetInterval(callback: () => void, milliseconds: number) {
  return window.setInterval(() => void callback(), milliseconds);
}
