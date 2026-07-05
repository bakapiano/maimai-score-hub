import {
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Switch,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageHeader } from "../components/PageHeader";
import { ResponsiveTable } from "../components/ResponsiveTable";
import { adminFetch } from "../api/client";
import { formatTime, useAdminContext } from "../utils/admin";

const { Text } = Typography;

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

const LEVEL_COLOR: Record<string, string> = {
  info: "default",
  warn: "gold",
  error: "red",
  debug: "blue",
};

const POLL_INTERVAL_MS = 3_000;

export default function WorkerLogsPage() {
  const { password, environment, logWindow } = useAdminContext();
  const [workers, setWorkers] = useState<WorkerEntry[]>([]);
  const [filterService, setFilterService] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<string | null>(null);
  const [filterWorker, setFilterWorker] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string | null>(null);
  const [filterQ, setFilterQ] = useState("");
  const [filterQDebounced, setFilterQDebounced] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [items, setItems] = useState<WorkerLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const cancelled = useRef(false);
  const workersRequestInFlight = useRef(false);
  const logsRequestInFlight = useRef(false);

  useEffect(() => {
    const id = window.setTimeout(() => setFilterQDebounced(filterQ), 300);
    return () => window.clearTimeout(id);
  }, [filterQ]);

  const loadWorkers = useCallback(async () => {
    if (!password) return;
    if (workersRequestInFlight.current) return;
    workersRequestInFlight.current = true;
    try {
      const body = await adminFetch<WorkerEntry[]>(
        environment,
        "/admin/history/log-workers",
        password,
        { env: environment, sinceMinutes: logWindow },
      );
      if (!cancelled.current) {
        setWorkers(body);
      }
    } finally {
      workersRequestInFlight.current = false;
    }
  }, [environment, logWindow, password]);

  const load = useCallback(async () => {
    if (!password) return;
    if (logsRequestInFlight.current) return;
    logsRequestInFlight.current = true;
    setLoading(true);
    try {
      const body = await adminFetch<WorkerLogRow[]>(
        environment,
        "/admin/history/logs",
        password,
        {
          env: environment,
          service: filterService,
          workerKind: filterKind,
          workerId: filterWorker,
          level: filterLevel,
          q: filterQDebounced.trim() || null,
          sinceMinutes: logWindow,
          limit: 500,
        },
      );
      if (!cancelled.current) {
        setItems(body);
      }
    } finally {
      logsRequestInFlight.current = false;
      setLoading(false);
    }
  }, [
    environment,
    filterKind,
    filterLevel,
    filterQDebounced,
    filterService,
    filterWorker,
    password,
    logWindow,
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
  }, [autoRefresh, load, loadWorkers]);

  const columns: TableColumnsType<WorkerLogRow> = useMemo(
    () => [
      {
        title: "时间",
        dataIndex: "ts",
        key: "ts",
        width: 140,
        render: (value: string) => (
          <Text className="cell-monospace">
            {formatTime(value)}.
            {String(new Date(value).getMilliseconds()).padStart(3, "0")}
          </Text>
        ),
      },
      {
        title: "service",
        dataIndex: "service",
        key: "service",
        width: 140,
        render: (value: string) => <Tag color={serviceColor(value)}>{value || "-"}</Tag>,
      },
      {
        title: "kind",
        dataIndex: "workerKind",
        key: "workerKind",
        width: 90,
        render: (value: string) => <Tag>{value || "-"}</Tag>,
      },
      {
        title: "instance",
        key: "instance",
        width: 240,
        render: (_, row) => (
          <Text className="cell-monospace">
            {row.workerId || row.instance || "-"}
          </Text>
        ),
      },
      {
        title: "级别",
        dataIndex: "level",
        key: "level",
        width: 90,
        render: (value: string) => <Tag color={LEVEL_COLOR[value]}>{value}</Tag>,
      },
      {
        title: "context",
        key: "context",
        width: 160,
        render: (_, row) => (
          <Text ellipsis={{ tooltip: row.eventName || row.errorClass || "-" }}>
            {row.eventName || row.errorClass || "-"}
          </Text>
        ),
      },
      {
        title: "job",
        dataIndex: "jobId",
        key: "jobId",
        width: 120,
        render: (value?: string) => (
          <Text className="cell-monospace">
            {value ? value.slice(0, 8) : "-"}
          </Text>
        ),
      },
      {
        title: "message",
        dataIndex: "message",
        key: "message",
        width: 520,
        render: (value: string, row) => (
          <Text
            className="log-message"
            type={row.level === "error" ? "danger" : undefined}
          >
            {value}
          </Text>
        ),
      },
    ],
    [],
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="实时日志流"
        description={`ClickHouse structured_logs，统一展示 backend / dxnet / sdgb 日志流；当前显示 ${items.length} 条。`}
        extra={
          <>
            <Switch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              checkedChildren="自动刷新"
              unCheckedChildren="手动刷新"
            />
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => {
                void load();
                void loadWorkers();
              }}
            >
              立即刷新
            </Button>
          </>
        }
      />

      <Card className="admin-card filter-card">
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} lg={4}>
            <Select
              placeholder="service"
              allowClear
              showSearch
              value={filterService}
              onChange={setFilterService}
              options={[
                { value: "backend", label: "backend" },
                { value: "dxnet-worker", label: "dxnet-worker" },
                { value: "sdgb-worker", label: "sdgb-worker" },
              ]}
              style={{ width: "100%" }}
            />
          </Col>
          <Col xs={24} sm={12} lg={3}>
            <Select
              placeholder="kind"
              allowClear
              value={filterKind}
              onChange={setFilterKind}
              options={[
                { value: "backend", label: "backend" },
                { value: "sdgb", label: "sdgb" },
                { value: "dxnet", label: "dxnet" },
              ]}
              style={{ width: "100%" }}
            />
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Select
              placeholder="worker 实例"
              allowClear
              showSearch
              value={filterWorker}
              onChange={setFilterWorker}
              options={workers.map((worker) => ({
                value: worker.workerId,
                label: `${worker.workerKind} · ${worker.workerId}`,
              }))}
              style={{ width: "100%" }}
            />
          </Col>
          <Col xs={24} sm={12} lg={3}>
            <Select
              placeholder="级别"
              allowClear
              value={filterLevel}
              onChange={setFilterLevel}
              options={[
                { value: "info", label: "info" },
                { value: "warn", label: "warn" },
                { value: "error", label: "error" },
                { value: "debug", label: "debug" },
              ]}
              style={{ width: "100%" }}
            />
          </Col>
          <Col xs={24} sm={12} lg={4}>
            <Input
              placeholder="message 包含..."
              value={filterQ}
              onChange={(event) => setFilterQ(event.target.value)}
            />
          </Col>
        </Row>
      </Card>

      <Card className="admin-card wide-table-card">
        <ResponsiveTable
          rowKey={(row, index) =>
            `${row.ts}-${row.service}-${row.workerId}-${index}`
          }
          size="small"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={false}
          scroll={{ y: 640 }}
          renderMobileItem={(row) => (
            <div className="mobile-fields">
              <div className="mobile-log-title">
                <Text className="cell-monospace">
                  {formatTime(row.ts)}.
                  {String(new Date(row.ts).getMilliseconds()).padStart(3, "0")}
                </Text>
                <Tag color={LEVEL_COLOR[row.level]}>{row.level}</Tag>
              </div>
              <div className="mobile-field">
                <Text type="secondary">service</Text>
                <Tag color={serviceColor(row.service)}>{row.service || "-"}</Tag>
              </div>
              <div className="mobile-field">
                <Text type="secondary">kind</Text>
                <Tag>{row.workerKind || "-"}</Tag>
              </div>
              <div className="mobile-field">
                <Text type="secondary">instance</Text>
                <Text className="cell-monospace">
                  {row.workerId || row.instance || "-"}
                </Text>
              </div>
              <div className="mobile-field">
                <Text type="secondary">context</Text>
                <span>{row.eventName || row.errorClass || "-"}</span>
              </div>
              <div className="mobile-field">
                <Text type="secondary">job</Text>
                <Text className="cell-monospace">
                  {row.jobId ? row.jobId.slice(0, 8) : "-"}
                </Text>
              </div>
              <div className="mobile-field mobile-field-block">
                <Text type="secondary">message</Text>
                <Text
                  className="log-message"
                  type={row.level === "error" ? "danger" : undefined}
                >
                  {row.message}
                </Text>
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}

function serviceColor(service: string): string {
  if (service === "backend") return "blue";
  if (service === "dxnet-worker") return "orange";
  if (service === "sdgb-worker") return "purple";
  return "default";
}
