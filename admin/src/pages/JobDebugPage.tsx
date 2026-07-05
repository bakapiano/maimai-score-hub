import {
  Button,
  Card,
  Col,
  Empty,
  Input,
  Pagination,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { BugOutlined, SearchOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DynamicTable } from "../components/DynamicTable";
import { JsonBlock } from "../components/JsonBlock";
import { PageHeader } from "../components/PageHeader";
import { ResponsiveTable } from "../components/ResponsiveTable";
import { adminFetch, adminHeaders, createAdminApi } from "../api/client";
import {
  ERROR_CATEGORY_META,
  type SearchJobResult,
  categorizeJobError,
  formatDateTime,
  useAdminContext,
} from "../utils/admin";

const { Paragraph, Text } = Typography;

type JobDebugView = {
  timeline: Array<Record<string, unknown>>;
  externalApiCalls: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  artifacts: string[];
};

export default function JobDebugPage() {
  const { password, environment } = useAdminContext();
  const adminApi = useMemo(() => createAdminApi(environment), [environment]);
  const [friendCode, setFriendCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [hideUserErrors, setHideUserErrors] = useState(true);
  const [jobs, setJobs] = useState<SearchJobResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDebug, setJobDebug] = useState<JobDebugView | null>(null);
  const [jobDebugLoading, setJobDebugLoading] = useState(false);
  const didInitialSearch = useRef(false);

  const searchJobs = useCallback(
    async (nextPage = 1) => {
      if (!password) return;
      setLoading(true);
      try {
        const res = await adminApi.searchJobs({
          headers: adminHeaders(password),
          query: {
            friendCode: friendCode.trim() || undefined,
            status: status || undefined,
            page: nextPage,
            pageSize: 10,
          },
        });
        if (res.status === 200) {
          const body = res.body as {
            data: SearchJobResult[];
            total: number;
            page: number;
            pageSize: number;
          };
          setJobs(body.data ?? []);
          setTotal(body.total ?? 0);
          setPage(body.page ?? nextPage);
        }
      } finally {
        setLoading(false);
      }
    },
    [adminApi, password, friendCode, status],
  );

  const loadJobDebug = useCallback(
    async (jobId: string) => {
      if (!password) return;
      setSelectedJobId(jobId);
      setJobDebugLoading(true);
      try {
        const body = await adminFetch<JobDebugView>(
          environment,
          `/admin/jobs/${jobId}/debug`,
          password,
          { env: environment },
        );
        setJobDebug(body);
      } catch {
        setJobDebug(null);
      } finally {
        setJobDebugLoading(false);
      }
    },
    [environment, password],
  );

  useEffect(() => {
    if (!password || didInitialSearch.current) return;
    didInitialSearch.current = true;
    void searchJobs(1);
  }, [password, searchJobs]);

  const filteredJobs = useMemo(
    () =>
      jobs.filter(
        (job) =>
          !hideUserErrors || categorizeJobError(job.error) !== "user_error",
      ),
    [hideUserErrors, jobs],
  );

  const selectedJob = jobs.find((job) => job.id === selectedJobId);

  const columns: TableColumnsType<SearchJobResult> = [
    {
      title: "好友码",
      dataIndex: "friendCode",
      key: "friendCode",
      width: 160,
      render: (value: string) => (
        <Text className="cell-monospace">{value}</Text>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: string) => <Tag color={statusColor(value)}>{value}</Tag>,
    },
    { title: "阶段", dataIndex: "stage", key: "stage", width: 180 },
    {
      title: "Bot",
      dataIndex: "botUserFriendCode",
      key: "botUserFriendCode",
      width: 160,
      render: (value: string | null) => (
        <Text className="cell-monospace">{value ?? "-"}</Text>
      ),
    },
    {
      title: "错误",
      dataIndex: "error",
      key: "error",
      width: 320,
      render: (value: string | null) => {
        if (!value) return <Text type="secondary">-</Text>;
        const category = categorizeJobError(value);
        const meta = ERROR_CATEGORY_META[category];
        return (
          <Space size={6} align="start">
            <Tag color={meta.color}>{meta.label}</Tag>
            <Paragraph
              ellipsis={{ rows: 1, tooltip: value }}
              style={{ marginBottom: 0, maxWidth: 220 }}
              type="danger"
            >
              {value}
            </Paragraph>
          </Space>
        );
      },
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 190,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: "操作",
      key: "actions",
      width: 100,
      render: (_, row) => (
        <Button
          type={selectedJobId === row.id ? "primary" : "link"}
          onClick={() => void loadJobDebug(row.id)}
          loading={jobDebugLoading && selectedJobId === row.id}
        >
          调试
        </Button>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        title="任务调试"
        description="按好友码和状态搜索任务，查看原始 job、ClickHouse timeline、外部 API 调用和结构化日志。"
      />

      <Card className="admin-card filter-card">
        <Row gutter={[12, 12]} align="bottom">
          <Col xs={24} md={8}>
            <Text type="secondary">好友码</Text>
            <Input
              placeholder="输入好友码筛选"
              value={friendCode}
              onChange={(event) => setFriendCode(event.target.value)}
              onPressEnter={() => void searchJobs(1)}
            />
          </Col>
          <Col xs={24} md={5}>
            <Text type="secondary">状态</Text>
            <Select
              allowClear
              placeholder="全部"
              value={status}
              onChange={setStatus}
              options={[
                { value: "queued", label: "排队中" },
                { value: "processing", label: "处理中" },
                { value: "completed", label: "已完成" },
                { value: "failed", label: "失败" },
                { value: "canceled", label: "已取消" },
              ]}
              style={{ width: "100%" }}
            />
          </Col>
          <Col xs={24} md={6}>
            <Switch
              checked={hideUserErrors}
              onChange={setHideUserErrors}
              checkedChildren="隐藏用户原因"
              unCheckedChildren="显示用户原因"
            />
          </Col>
          <Col xs={24} md={5}>
            <Button
              type="primary"
              icon={<SearchOutlined />}
              onClick={() => void searchJobs(1)}
              loading={loading}
              block
            >
              搜索
            </Button>
          </Col>
        </Row>
      </Card>

      <Card
        className="admin-card wide-table-card"
        title={
          <Space>
            <BugOutlined />
            搜索结果
            <Tag>{total}</Tag>
          </Space>
        }
      >
        <ResponsiveTable
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={filteredJobs}
          loading={loading}
          pagination={false}
          rowClassName={(row) =>
            row.id === selectedJobId ? "ant-table-row-selected" : ""
          }
          renderMobileItem={(job) => {
            const category = categorizeJobError(job.error);
            const meta = ERROR_CATEGORY_META[category];
            return (
              <div className="mobile-fields">
                <Text strong className="mobile-card-title">
                  {job.friendCode}
                </Text>
                <div className="mobile-field">
                  <Text type="secondary">状态</Text>
                  <Tag color={statusColor(job.status)}>{job.status}</Tag>
                </div>
                <div className="mobile-field">
                  <Text type="secondary">阶段</Text>
                  <span>{job.stage}</span>
                </div>
                <div className="mobile-field">
                  <Text type="secondary">Bot</Text>
                  <Text className="cell-monospace">
                    {job.botUserFriendCode ?? "-"}
                  </Text>
                </div>
                {job.error ? (
                  <div className="mobile-field mobile-field-block">
                    <Text type="secondary">错误</Text>
                    <div>
                      <Tag color={meta.color}>{meta.label}</Tag>
                      <Paragraph type="danger">{job.error}</Paragraph>
                    </div>
                  </div>
                ) : null}
                <div className="mobile-field">
                  <Text type="secondary">创建时间</Text>
                  <span>{formatDateTime(job.createdAt)}</span>
                </div>
                <Button
                  type={selectedJobId === job.id ? "primary" : "default"}
                  onClick={() => void loadJobDebug(job.id)}
                  loading={jobDebugLoading && selectedJobId === job.id}
                  block
                >
                  调试
                </Button>
              </div>
            );
          }}
        />
        {jobs.length ? (
          <div style={{ padding: "0 16px 16px" }}>
            <Pagination
              current={page}
              total={total}
              pageSize={10}
              showSizeChanger={false}
              onChange={(nextPage) => void searchJobs(nextPage)}
            />
          </div>
        ) : null}
      </Card>

      {selectedJobId ? (
        <Card
          className="admin-card"
          title={`任务详情 (Job: ${selectedJobId.slice(0, 8)}...)`}
          extra={
            <Tag>
              {(jobDebug?.externalApiCalls.length ?? 0).toLocaleString()} 条 API
              调用
            </Tag>
          }
          loading={jobDebugLoading}
        >
          {selectedJob ? <JsonBlock value={selectedJob.raw} /> : null}

          {jobDebug ? (
            <div className="page-stack" style={{ marginTop: 16 }}>
              <Card title="Timeline" className="admin-card wide-table-card">
                <DynamicTable rows={jobDebug.timeline} />
              </Card>
              <Card
                title="External API calls"
                className="admin-card wide-table-card"
              >
                <DynamicTable rows={jobDebug.externalApiCalls} />
              </Card>
              <Card title="Structured logs" className="admin-card wide-table-card">
                <DynamicTable rows={jobDebug.logs} />
              </Card>
              <Card title="Artifacts" className="admin-card">
                {jobDebug.artifacts.length ? (
                  <Space wrap>
                    {jobDebug.artifacts.map((artifact) => (
                      <Tag key={artifact}>{artifact}</Tag>
                    ))}
                  </Space>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无 artifact"
                  />
                )}
              </Card>
            </div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无 ClickHouse debug 数据"
              style={{ marginTop: 16 }}
            />
          )}
        </Card>
      ) : null}
    </div>
  );
}

function statusColor(status: string) {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "processing") return "blue";
  if (status === "canceled") return "default";
  return "gold";
}
