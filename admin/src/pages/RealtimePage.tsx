import {
  App as AntdApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Input,
  Modal,
  Popconfirm,
  Space,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  IdcardOutlined,
  QrcodeOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DynamicTable } from "../components/DynamicTable";
import { LazyColumnChart } from "../components/LazyColumnChart";
import { LazyLineChart } from "../components/LazyLineChart";
import { MetricCard } from "../components/MetricCard";
import { PageHeader } from "../components/PageHeader";
import { ResponsiveTable } from "../components/ResponsiveTable";
import {
  adminFetch,
  adminHeaders,
  buildApiUrl,
  createAdminApi,
} from "../api/client";
import {
  type RealtimeWindow,
  formatDateTime,
  formatDuration,
  formatSeconds,
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
const WORKER_HEALTH_MIN_TERMINAL_COUNT = 10;
const WORKER_HEALTH_MIN_SUCCESS_RATE = 80;
const WORKER_QUEUE_BACKLOG_AGE_SECONDS = 10 * 60;
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
  const [workerGroups, setWorkerGroups] = useState<RealtimeWorkerGroups | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [activeWorkerKind, setActiveWorkerKind] = useState<WorkerKind>("dxnet");
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
          value={
            clickhouse?.ping ? "正常" : clickhouse?.enabled ? "异常" : "关闭"
          }
          status={
            clickhouse?.ping ? "OK" : clickhouse?.enabled ? "ERROR" : "OFF"
          }
          color={
            clickhouse?.ping ? "green" : clickhouse?.enabled ? "red" : "default"
          }
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
              children:
                kind === activeWorkerKind ? (
                  <WorkerMonitorPanel
                    group={workerGroups?.groups.find(
                      (candidate) => candidate.workerKind === kind,
                    )}
                    password={password}
                    environment={environment}
                    onRefresh={load}
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
        <Tag color={row.color} title={row.statusDetail}>
          {value}
        </Tag>
      ),
    },
    {
      title: "在线 / 实例",
      key: "workers",
      width: 110,
      render: (_: unknown, row: ReturnType<typeof summarizeWorkerGroup>) =>
        `${row.onlineWorkerCount} / ${row.workerCount}`,
    },
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
    {
      title: "最近错误",
      dataIndex: "errorCount",
      key: "errorCount",
      width: 100,
    },
    {
      title: "活跃任务",
      dataIndex: "activeCount",
      key: "activeCount",
      width: 100,
    },
  ];

  return (
    <Card className="admin-card wide-table-card" title="Worker 总览">
      <ResponsiveTable
        rowKey="kind"
        size="middle"
        columns={columns}
        dataSource={rows}
        pagination={false}
        expandable={{
          rowExpandable: (row) => row.workers.length > 0,
          expandedRowRender: (row) => (
            <WorkerInstanceSubItems workers={row.workers} />
          ),
        }}
        renderMobileItem={(row) => (
          <div className="worker-overview-mobile-item">
            <MobileFields
              title={row.title}
              fields={[
                [
                  "状态",
                  <Tag color={row.color} title={row.statusDetail}>
                    {row.status}
                  </Tag>,
                ],
                [
                  "在线 / 实例",
                  `${row.onlineWorkerCount} / ${row.workerCount}`,
                ],
                ["排队 / 处理", `${row.queued} / ${row.processing}`],
                [
                  "最近成功 / 失败",
                  `${row.recentSuccess} / ${row.recentFailed}`,
                ],
                [
                  "成功率",
                  <Tag color={row.successRateColor}>
                    {row.successRateLabel}
                  </Tag>,
                ],
                ["p95 耗时", row.p95Label],
                ["最近错误", row.errorCount],
                ["活跃任务", row.activeCount],
              ]}
            />
            {row.workers.length ? (
              <Collapse
                size="small"
                items={[
                  {
                    key: "instances",
                    label: `实例详情 (${row.workers.length})`,
                    children: <WorkerInstanceSubItems workers={row.workers} />,
                  },
                ]}
              />
            ) : null}
          </div>
        )}
      />
    </Card>
  );
}

function WorkerInstanceSubItems({
  workers,
}: {
  workers: Array<Record<string, unknown>>;
}) {
  return (
    <div className="worker-sub-grid">
      {workers.map((worker, index) => {
        const workerId = String(
          worker.workerId ?? worker.botFriendCode ?? `worker-${index + 1}`,
        );
        const online = isWorkerAlive(worker);
        return (
          <Card
            key={`${workerId}-${index}`}
            size="small"
            title={<Text className="cell-monospace">{workerId}</Text>}
            extra={
              <Space size={4} wrap>
                <Tag color={online ? "green" : "red"}>
                  {online ? "在线" : "离线"}
                </Tag>
                {"available" in worker ? (
                  <Tag color={worker.available ? "green" : "red"}>
                    Cookie {worker.available ? "可用" : "过期"}
                  </Tag>
                ) : null}
              </Space>
            }
          >
            <Descriptions
              size="small"
              column={1}
              items={buildWorkerDescriptionItems(worker)}
            />
          </Card>
        );
      })}
    </div>
  );
}

function buildWorkerDescriptionItems(worker: Record<string, unknown>) {
  const fields: Array<[string, string]> = [
    ["lastSeenAt", "最近上报"],
    ["remark", "备注"],
    ["friendCount", "好友数"],
    ["cabinetUserId", "Cabinet User ID"],
    ["jobsClaimed", "已领取任务"],
    ["concurrency", "并发数"],
  ];
  return fields
    .filter(([key]) => key in worker)
    .map(([key, label]) => ({
      key,
      label,
      children:
        key === "lastSeenAt"
          ? formatDateTime(String(worker[key] ?? ""))
          : formatWorkerDetailValue(worker[key]),
    }));
}

function formatWorkerDetailValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function summarizeWorkerGroup(
  group: WorkerGroup | undefined,
  kind: WorkerKind,
) {
  const title =
    kind === "dxnet" ? "DXNet" : kind === "sdgb" ? "SDGB" : "查分器导出";
  if (!group) {
    return {
      kind,
      title,
      status: "无数据",
      statusDetail: "尚未返回 Worker 数据",
      color: "default",
      workerCount: 0,
      onlineWorkerCount: 0,
      workers: [] as Array<Record<string, unknown>>,
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
  const onlineWorkers = group.workers.filter(isWorkerAlive);
  const onlineWorkerCount = onlineWorkers.length;
  const errorCount = group.recentErrors.reduce(
    (sum, row) => sum + row.count,
    0,
  );
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
  const hasSignificantFailures =
    successTotals.total >= WORKER_HEALTH_MIN_TERMINAL_COUNT &&
    successRate !== null &&
    successRate < WORKER_HEALTH_MIN_SUCCESS_RATE;
  const oldestQueuedAgeSeconds = Math.max(
    0,
    ...group.queueByJobType.map((row) => row.oldestQueuedAgeSeconds ?? 0),
  );
  const hasQueueBacklog =
    queued > 0 && oldestQueuedAgeSeconds > WORKER_QUEUE_BACKLOG_AGE_SECONDS;
  const hasUsableDxnetBot =
    kind !== "dxnet" || onlineWorkers.some((row) => row.available === true);
  const p95Values = group.durationTrend
    .map((row) => row.p95Ms)
    .filter((value): value is number => typeof value === "number");
  const maxP95 = p95Values.length ? Math.max(...p95Values) : null;
  let status = "正常";
  let statusDetail = "暂无积压或显著失败";
  let color = "green";
  if (group.workers.length === 0) {
    status = "无实例";
    statusDetail = "没有注册的 Worker 实例";
    color = "red";
  } else if (onlineWorkerCount === 0) {
    status = "离线";
    statusDetail = "所有实例均已超过 5 分钟未上报";
    color = "red";
  } else if (!hasUsableDxnetBot) {
    status = "Cookie 异常";
    statusDetail = "在线 DXNet Bot 均无可用 Cookie";
    color = "red";
  } else if (hasSignificantFailures) {
    status = "异常";
    statusDetail = `成功率 ${successRate}%（成功 ${successTotals.completed} / 失败 ${successTotals.failed}）`;
    color = "red";
  } else if (hasQueueBacklog) {
    status = "积压";
    statusDetail = `最久排队 ${formatSeconds(oldestQueuedAgeSeconds)}`;
    color = "gold";
  } else if (queued > 0 || processing > 0) {
    status = "处理中";
    statusDetail = `排队 ${queued} / 处理 ${processing}`;
    color = "blue";
  }

  return {
    kind,
    title,
    status,
    statusDetail,
    color,
    workerCount: group.workers.length,
    onlineWorkerCount,
    workers: group.workers,
    queued,
    processing,
    successRateLabel: successRate === null ? "-" : `${successRate}%`,
    successRateColor:
      successRate === null ||
      successTotals.total < WORKER_HEALTH_MIN_TERMINAL_COUNT
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

function WorkerMonitorPanel({
  group,
  password,
  environment,
  onRefresh,
}: {
  group: WorkerGroup | undefined;
  password: string;
  environment: "prod" | "dev";
  onRefresh: () => Promise<void>;
}) {
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
        <MetricCard
          title="Worker 实例"
          value={group.workers.length}
          status="live"
        />
        <MetricCard
          title="排队中"
          value={sumQueue(group.queueByJobType, "queued")}
          color={
            sumQueue(group.queueByJobType, "queued") > 0 ? "gold" : "default"
          }
          status="queued"
        />
        <MetricCard
          title="处理中"
          value={sumQueue(group.queueByJobType, "processing")}
          color={
            sumQueue(group.queueByJobType, "processing") > 0
              ? "blue"
              : "default"
          }
          status="processing"
        />
        <MetricCard
          title="最近错误"
          value={group.recentErrors.reduce((sum, row) => sum + row.count, 0)}
          color={group.recentErrors.length > 0 ? "red" : "default"}
          status="hits"
        />
      </div>

      <div className="panel-grid-2">
        <QueueByJobTypeTable rows={group.queueByJobType} />
        <WorkerInstancesTable
          rows={group.workers}
          workerKind={group.workerKind}
          password={password}
          environment={environment}
          onRefresh={onRefresh}
        />
      </div>

      <div className="panel-grid-2">
        <ActiveWorkerJobsTable jobs={group.activeJobs} />
        <RecentErrorsTable rows={group.recentErrors} />
      </div>

      <div className="panel-grid-2">
        <SuccessRateTrendCard data={group.successRateTrend} />
        <CountTrendCard data={group.successRateTrend} />
      </div>

      <div className="panel-grid-2">
        <TrendCard
          title="耗时趋势 p95"
          data={group.durationTrend}
          valueKey="p95Ms"
          valueFormatter={formatChartDuration}
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

function WorkerInstancesTable({
  rows,
  workerKind,
  password,
  environment,
  onRefresh,
}: {
  rows: Array<Record<string, unknown>>;
  workerKind: WorkerKind;
  password: string;
  environment: "prod" | "dev";
  onRefresh: () => Promise<void>;
}) {
  const { message } = AntdApp.useApp();
  const adminApi = useMemo(() => createAdminApi(environment), [environment]);
  const [editDialog, setEditDialog] = useState<{
    kind: "remark" | "cabinet" | "qr";
    friendCode: string;
    value: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingFriendCode, setRemovingFriendCode] = useState<string | null>(
    null,
  );
  const hasDxnetBots = workerKind === "dxnet";

  const saveEdit = async () => {
    if (!editDialog || !password || saving) return;
    const { friendCode, kind } = editDialog;
    const trimmed = editDialog.value.trim();

    let cabinetUserId: number | null = null;
    if (kind === "cabinet" && trimmed) {
      cabinetUserId = Number(trimmed);
      if (
        !/^\d+$/.test(trimmed) ||
        !Number.isSafeInteger(cabinetUserId) ||
        cabinetUserId <= 0
      ) {
        message.error("Cabinet User ID 必须是正整数，留空表示清除");
        return;
      }
    }

    setSaving(true);
    try {
      if (kind === "qr") {
        if (!trimmed) {
          message.error("请输入 QR 字符串");
          return;
        }
        const response = await fetch(
          buildApiUrl(
            environment,
            `/admin/bots/${encodeURIComponent(friendCode)}/cabinet/bind-qr`,
          ),
          {
            method: "POST",
            headers: {
              ...adminHeaders(password),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ qrCode: trimmed }),
          },
        );
        const responseBody = (await response.json().catch(() => null)) as {
          cabinetUserId?: number;
          message?: string;
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(
            responseBody?.message ??
              responseBody?.error ??
              `HTTP ${response.status}`,
          );
        }
        message.success(
          responseBody?.cabinetUserId
            ? `扫码绑定成功：${responseBody.cabinetUserId}`
            : "扫码绑定成功",
        );
      } else {
        const res =
          kind === "remark"
            ? await adminApi.updateBotRemark({
                headers: adminHeaders(password),
                params: { friendCode },
                body: { remark: trimmed || null },
              })
            : await adminApi.updateBotCabinetUserId({
                headers: adminHeaders(password),
                params: { friendCode },
                body: { cabinetUserId },
              });
        if (res.status !== 200) {
          throw new Error(`HTTP ${res.status}`);
        }
        message.success(
          kind === "remark" ? "备注已保存" : "Cabinet User ID 已保存",
        );
      }
      setEditDialog(null);
      await onRefresh().catch(() => {});
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const removeBot = async (friendCode: string) => {
    if (!password) return;
    setRemovingFriendCode(friendCode);
    try {
      const res = await adminApi.removeBot({
        headers: adminHeaders(password),
        params: { friendCode },
      });
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }
      message.success("Bot 已删除");
      await onRefresh().catch(() => {});
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setRemovingFriendCode(null);
    }
  };

  const renderBotActions = (
    row: Record<string, unknown>,
    showLabels = false,
  ) => {
    if (!("available" in row)) return null;
    const friendCode = String(row.workerId ?? row.botFriendCode ?? "");
    return (
      <Space size={4} wrap>
        <Button
          size="small"
          icon={<EditOutlined />}
          title="编辑备注"
          aria-label="编辑备注"
          onClick={() =>
            setEditDialog({
              kind: "remark",
              friendCode,
              value: String(row.remark ?? ""),
            })
          }
        >
          {showLabels ? "备注" : null}
        </Button>
        <Button
          size="small"
          icon={<IdcardOutlined />}
          title="绑定 Cabinet User ID"
          aria-label="绑定 Cabinet User ID"
          onClick={() =>
            setEditDialog({
              kind: "cabinet",
              friendCode,
              value:
                row.cabinetUserId === null || row.cabinetUserId === undefined
                  ? ""
                  : String(row.cabinetUserId),
            })
          }
        >
          {showLabels ? "Cabinet ID" : null}
        </Button>
        <Button
          size="small"
          icon={<QrcodeOutlined />}
          title="扫码绑定 Cabinet"
          aria-label="扫码绑定 Cabinet"
          onClick={() =>
            setEditDialog({
              kind: "qr",
              friendCode,
              value: "",
            })
          }
        >
          {showLabels ? "QR 绑定" : null}
        </Button>
        <Popconfirm
          title={`删除 Bot ${friendCode}？`}
          description="仍在运行的 Bot 会在下次心跳时重新出现。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeBot(friendCode)}
        >
          <Button
            danger
            size="small"
            icon={<DeleteOutlined />}
            title="删除 Bot"
            aria-label="删除 Bot"
            loading={removingFriendCode === friendCode}
          >
            {showLabels ? "删除" : null}
          </Button>
        </Popconfirm>
      </Space>
    );
  };

  const columns = [
    {
      title: "workerId",
      key: "workerId",
      width: 170,
      render: (row: Record<string, unknown>) => (
        <Text className="cell-monospace">
          {String(row.workerId ?? row.botFriendCode ?? "-")}
        </Text>
      ),
    },
    {
      title: "在线",
      key: "online",
      width: 80,
      render: (row: Record<string, unknown>) => (
        <Tag color={isWorkerAlive(row) ? "green" : "red"}>
          {isWorkerAlive(row) ? "在线" : "离线"}
        </Tag>
      ),
    },
    ...(hasDxnetBots
      ? [
          {
            title: "Cookie",
            key: "cookie",
            width: 80,
            render: (row: Record<string, unknown>) => (
              <Tag color={row.available ? "green" : "red"}>
                {row.available ? "可用" : "过期"}
              </Tag>
            ),
          },
          {
            title: "操作",
            key: "actions",
            width: 150,
            render: (row: Record<string, unknown>) => renderBotActions(row),
          },
        ]
      : []),
    {
      title: "最近上报",
      key: "lastSeenAt",
      width: 180,
      render: (row: Record<string, unknown>) =>
        formatDateTime(String(row.lastSeenAt ?? "")),
    },
    {
      title: "信息",
      key: "info",
      width: 260,
      render: (row: Record<string, unknown>) => formatWorkerInfo(row),
    },
  ];

  return (
    <Card
      className="admin-card wide-table-card"
      title={hasDxnetBots ? "DXNet Bot 实例" : "Worker 实例"}
    >
      <ResponsiveTable
        size="small"
        rowKey={(row, index) => `${String(row.workerId ?? index)}-${index}`}
        columns={columns}
        dataSource={rows}
        pagination={false}
        renderMobileItem={(row) => {
          const fields: Array<[string, ReactNode]> = [
            [
              "在线状态",
              <Tag color={isWorkerAlive(row) ? "green" : "red"}>
                {isWorkerAlive(row) ? "在线" : "离线"}
              </Tag>,
            ],
          ];
          if ("available" in row) {
            fields.push(
              [
                "Cookie 状态",
                <Tag color={row.available ? "green" : "red"}>
                  {row.available ? "可用" : "过期"}
                </Tag>,
              ],
              ["操作", renderBotActions(row, true)],
            );
          }
          fields.push(
            ["最近上报", formatDateTime(String(row.lastSeenAt ?? ""))],
            ["信息", formatWorkerInfo(row)],
          );
          return (
            <MobileFields
              title={String(row.workerId ?? row.botFriendCode ?? "-")}
              fields={fields}
            />
          );
        }}
      />
      <Modal
        open={editDialog !== null}
        title={
          editDialog?.kind === "remark"
            ? `编辑备注 · ${editDialog.friendCode}`
            : editDialog?.kind === "qr"
              ? `扫码绑定 Cabinet · ${editDialog.friendCode}`
              : `编辑 Cabinet User ID · ${editDialog?.friendCode ?? ""}`
        }
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void saveEdit()}
        onCancel={() => setEditDialog(null)}
        destroyOnHidden
      >
        {editDialog?.kind === "qr" ? (
          <Input.TextArea
            autoFocus
            autoSize={{ minRows: 3, maxRows: 6 }}
            value={editDialog.value}
            placeholder="粘贴 Bot 卡牌上的 QR 字符串（SGWCMAID...）"
            onChange={(event) =>
              setEditDialog((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
          />
        ) : (
          <Input
            autoFocus
            value={editDialog?.value ?? ""}
            inputMode={editDialog?.kind === "cabinet" ? "numeric" : "text"}
            placeholder={
              editDialog?.kind === "cabinet"
                ? "输入正整数；留空清除绑定"
                : "输入备注；留空清除备注"
            }
            onChange={(event) =>
              setEditDialog((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            onPressEnter={() => void saveEdit()}
          />
        )}
      </Modal>
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
      render: (row: WorkerActiveJob) =>
        row.workerId ?? row.botFriendCode ?? "-",
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
  const totalHits = rows.reduce((sum, row) => sum + row.count, 0);
  const sortedRows = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.count - a.row.count || a.index - b.index)
    .map(({ row }) => row);
  const columns = [
    {
      title: "Hits",
      dataIndex: "count",
      key: "count",
      width: 80,
      align: "center" as const,
      render: (value: number) => <Tag color="red">{value}</Tag>,
    },
    { title: "Job type", dataIndex: "jobType", key: "jobType", width: 180 },
    {
      title: "错误类型",
      dataIndex: "errorClass",
      key: "errorClass",
      width: 160,
      render: (value: string) => <Tag color="red">{value}</Tag>,
    },
    { title: "消息", dataIndex: "message", key: "message", width: 320 },
  ];

  return (
    <Card
      className="admin-card wide-table-card"
      title={`最近错误 · ${totalHits} hits`}
    >
      <ResponsiveTable
        size="small"
        rowKey={(row, index) => `${row.jobType}-${row.errorClass}-${index}`}
        columns={columns}
        dataSource={sortedRows}
        pagination={false}
        renderMobileItem={(row) => (
          <MobileFields
            title={row.jobType}
            fields={[
              ["Hits", <Tag color="red">{row.count}</Tag>],
              ["错误类型", <Tag color="red">{row.errorClass}</Tag>],
              ["消息", row.message],
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
  valueFormatter,
}: {
  title: string;
  data: Array<Record<string, unknown>>;
  valueKey: string;
  valueFormatter: (value: number) => string;
}) {
  const chartData = useMemo(
    () => toChartRows(data, valueKey),
    [data, valueKey],
  );

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
            y: { labelFormatter: valueFormatter },
          }}
          tooltip={{
            title: "bucketLabel",
            items: [
              {
                channel: "y",
                valueFormatter,
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

function formatChartDuration(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const milliseconds = Math.max(0, value);
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
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

function SuccessRateTrendCard({ data }: { data: SuccessRateTrendPoint[] }) {
  const chartData = useMemo(
    () =>
      data.map((row) => ({
        bucketLabel: formatBucketLabel(row.bucket),
        series: row.jobType,
        value: row.successRate,
        completed: row.completed,
        failed: row.failed,
      })),
    [data],
  );
  const totals = useMemo(
    () =>
      data.reduce(
        (sum, row) => ({
          completed: sum.completed + row.completed,
          failed: sum.failed + row.failed,
        }),
        { completed: 0, failed: 0 },
      ),
    [data],
  );

  return (
    <Card
      className="admin-card"
      title="成功率趋势"
      extra={
        <Space size={4} wrap>
          <Tag color="green">成功 {totals.completed}</Tag>
          <Tag color="red">失败 {totals.failed}</Tag>
        </Space>
      }
    >
      {chartData.length ? (
        <LazyColumnChart
          data={chartData}
          xField="bucketLabel"
          yField="value"
          colorField="series"
          group
          height={260}
          autoFit
          scale={{ y: { domain: [0, 100] } }}
          axis={{
            y: { labelFormatter: (value: number) => `${value}%` },
          }}
          tooltip={{
            title: "bucketLabel",
            items: [
              {
                field: "value",
                name: "成功率",
                valueFormatter: (value: number) => `${value}%`,
              },
              { field: "completed", name: "成功" },
              { field: "failed", name: "失败" },
            ],
          }}
        />
      ) : (
        <Text type="secondary">暂无趋势数据</Text>
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
  if (row.cabinetUserId) {
    parts.push(`Cabinet ${String(row.cabinetUserId)}`);
  }
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
