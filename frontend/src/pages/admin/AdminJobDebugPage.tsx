import {
  Badge,
  Button,
  Card,
  Code,
  Group,
  Pagination,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconBug } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import {
  type SearchJobResult,
  type AdminEnvironment,
  ERROR_CATEGORY_META,
  categorizeJobError,
  getDefaultAdminEnvironment,
  useAdminContext,
} from "./adminUtils";
import { adminApi } from "../../api/appClient";
import { ScrollableTable } from "../../components/ScrollableTable";

type JobDebugView = {
  timeline: Array<Record<string, unknown>>;
  externalApiCalls: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  artifacts: string[];
};

export default function AdminJobDebugPage() {
  const { password } = useAdminContext();
  const [env, setEnv] = useState<AdminEnvironment>(() =>
    getDefaultAdminEnvironment(),
  );

  const [friendCode, setFriendCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  // 默认隐藏"用户原因"分类失败（等好友超时 / 没绑 cabinet 等），让 admin
  // 一眼只看"系统/远端"问题。可勾选打开。
  const [hideUserErrors, setHideUserErrors] = useState(true);
  const [jobs, setJobs] = useState<SearchJobResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDebug, setJobDebug] = useState<JobDebugView | null>(null);
  const [jobDebugLoading, setJobDebugLoading] = useState(false);

  const searchJobs = useCallback(
    async (p = 1) => {
      if (!password) return;
      setLoading(true);
      const res = await adminApi.searchJobs({
        headers: { "x-api-secret": password },
        query: {
          friendCode: friendCode.trim() || undefined,
          status: status || undefined,
          page: p,
          pageSize: 10,
        },
      });
      setLoading(false);
      if (res.status === 200) {
        const body = res.body as {
          data: SearchJobResult[];
          total: number;
          page: number;
          pageSize: number;
        };
        setJobs(body.data ?? []);
        setTotal(body.total ?? 0);
        setPage(body.page ?? p);
      }
    },
    [password, friendCode, status],
  );

  const loadJobDebug = useCallback(
    async (jobId: string) => {
      if (!password) return;
      setSelectedJobId(jobId);
      setJobDebugLoading(true);
      const res = await fetch(`/api/v1/admin/jobs/${jobId}/debug?env=${env}`, {
        headers: { "x-api-secret": password },
      });
      setJobDebugLoading(false);
      if (res.ok) {
        setJobDebug((await res.json()) as JobDebugView);
      } else {
        setJobDebug(null);
      }
    },
    [env, password],
  );

  // 进入页面时用默认 filter 加载数据
  useEffect(() => {
    if (password) {
      void searchJobs(1);
    }
  }, [password]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card withBorder shadow="sm" padding="lg" radius="md">
      <Stack gap="md">
        <Group gap="xs">
          <IconBug size={20} />
          <Text fw={600}>任务调试</Text>
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
        </Group>

        <Group gap="sm" align="flex-end">
          <TextInput
            label="好友码"
            placeholder="输入好友码筛选"
            size="sm"
            value={friendCode}
            onChange={(e) => setFriendCode(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Select
            label="状态"
            placeholder="全部"
            size="sm"
            clearable
            value={status}
            onChange={setStatus}
            data={[
              { value: "queued", label: "排队中" },
              { value: "processing", label: "处理中" },
              { value: "completed", label: "已完成" },
              { value: "failed", label: "失败" },
              { value: "canceled", label: "已取消" },
            ]}
            style={{ width: 140 }}
          />
          <Switch
            label="隐藏用户原因失败"
            size="sm"
            checked={hideUserErrors}
            onChange={(e) => setHideUserErrors(e.currentTarget.checked)}
          />
          <Button
            variant="light"
            size="sm"
            onClick={() => searchJobs(1)}
            loading={loading}
          >
            搜索
          </Button>
        </Group>

        {jobs.length > 0 && (
          <>
            <ScrollableTable striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>好友码</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>阶段</Table.Th>
                  <Table.Th>Bot</Table.Th>
                  <Table.Th>错误</Table.Th>
                  <Table.Th>创建时间</Table.Th>
                  <Table.Th>操作</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs
                  .filter(
                    (job) =>
                      !hideUserErrors ||
                      categorizeJobError(job.error) !== "user_error",
                  )
                  .map((job) => (
                    <Table.Tr
                      key={job.id}
                      bg={
                        selectedJobId === job.id
                          ? "var(--mantine-color-blue-light)"
                          : undefined
                      }
                    >
                      <Table.Td>
                        <Text size="sm" ff="monospace">
                          {job.friendCode}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={
                            job.status === "completed"
                              ? "green"
                              : job.status === "failed"
                                ? "red"
                                : job.status === "processing"
                                  ? "blue"
                                  : job.status === "canceled"
                                    ? "gray"
                                    : "yellow"
                          }
                          variant="light"
                          size="sm"
                        >
                          {job.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{job.stage}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace" c="dimmed">
                          {job.botUserFriendCode ?? "-"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {job.error ? (
                          <Group gap={6} wrap="nowrap" align="flex-start">
                            {(() => {
                              const cat = categorizeJobError(job.error);
                              const meta = ERROR_CATEGORY_META[cat];
                              return (
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color={meta.color}
                                  style={{ flexShrink: 0 }}
                                >
                                  {meta.label}
                                </Badge>
                              );
                            })()}
                            <Text
                              size="sm"
                              c="red"
                              lineClamp={1}
                              style={{ maxWidth: 200 }}
                            >
                              {job.error}
                            </Text>
                          </Group>
                        ) : (
                          <Text size="sm" c="dimmed">
                            -
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {new Date(job.createdAt).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          variant="subtle"
                          size="xs"
                          onClick={() => loadJobDebug(job.id)}
                          loading={jobDebugLoading && selectedJobId === job.id}
                        >
                          调试
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
              </Table.Tbody>
            </ScrollableTable>
            <Group justify="space-between" align="center">
              <Text size="sm" c="dimmed">
                共 {total} 条记录
              </Text>
              <Pagination
                value={page}
                onChange={(p) => searchJobs(p)}
                total={Math.ceil(total / 10)}
                size="sm"
              />
            </Group>
          </>
        )}

        {selectedJobId && (
          <Card withBorder padding="md" radius="sm">
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <Text fw={600} size="sm">
                  任务详情 (Job: {selectedJobId.slice(0, 8)}...)
                </Text>
                <Badge variant="light" size="sm">
                  {(jobDebug?.externalApiCalls.length ?? 0).toLocaleString()} 条 API 调用
                </Badge>
              </Group>

              {/* 完整 Job JSON */}
              {(() => {
                const selectedJob = jobs.find((j) => j.id === selectedJobId);
                return selectedJob ? (
                  <ScrollArea h={300}>
                    <Code
                      block
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        fontSize: 12,
                      }}
                    >
                      {JSON.stringify(selectedJob.raw, null, 2)}
                    </Code>
                  </ScrollArea>
                ) : null;
              })()}

              {jobDebugLoading ? (
                <Text size="sm" c="dimmed">
                  加载中...
                </Text>
              ) : jobDebug ? (
                <Stack gap="md">
                  <DebugTable title="Timeline" rows={jobDebug.timeline} />
                  <DebugTable
                    title="External API calls"
                    rows={jobDebug.externalApiCalls}
                  />
                  <DebugTable title="Structured logs" rows={jobDebug.logs} />
                  <Card withBorder>
                    <Text fw={600} size="sm" mb="xs">
                      Artifacts
                    </Text>
                    {jobDebug.artifacts.length ? (
                      <Stack gap={4}>
                        {jobDebug.artifacts.map((artifact) => (
                          <Code key={artifact}>{artifact}</Code>
                        ))}
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">
                        暂无 artifact
                      </Text>
                    )}
                  </Card>
                </Stack>
              ) : (
                <Text size="sm" c="dimmed" ta="center">
                  暂无 ClickHouse debug 数据
                </Text>
              )}
            </Stack>
          </Card>
        )}

        {!loading && jobs.length === 0 && (
          <Text size="sm" c="dimmed" ta="center">
            暂无任务记录
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function DebugTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
}) {
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          {title}
        </Text>
        <Badge variant="light">{rows.length}</Badge>
      </Group>
      {!rows.length ? (
        <Text size="sm" c="dimmed">
          暂无数据
        </Text>
      ) : (
        <ScrollArea h={260}>
          <ScrollableTable striped highlightOnHover withTableBorder>
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
                    <Table.Td key={key}>
                      <Text size="xs" ff="monospace" lineClamp={2}>
                        {formatCell(row[key])}
                      </Text>
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </ScrollableTable>
        </ScrollArea>
      )}
    </Card>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
