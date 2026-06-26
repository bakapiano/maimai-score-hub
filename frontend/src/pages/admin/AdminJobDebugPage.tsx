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
  type ApiLogEntry,
  type SearchJobResult,
  ERROR_CATEGORY_META,
  categorizeJobError,
  useAdminContext,
} from "./adminUtils";
import { adminApi } from "../../api/appClient";
import { ScrollableTable } from "../../components/ScrollableTable";

export default function AdminJobDebugPage() {
  const { password } = useAdminContext();

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
  const [apiLogs, setApiLogs] = useState<ApiLogEntry[]>([]);
  const [apiLogsLoading, setApiLogsLoading] = useState(false);

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

  const loadApiLogs = useCallback(
    async (jobId: string) => {
      if (!password) return;
      setSelectedJobId(jobId);
      setApiLogsLoading(true);
      const res = await adminApi.getJobApiLogs({
        headers: { "x-api-secret": password },
        params: { jobId },
      });
      setApiLogsLoading(false);
      if (res.status === 200) {
        setApiLogs((res.body as ApiLogEntry[]) ?? []);
      } else {
        setApiLogs([]);
      }
    },
    [password],
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
                          onClick={() => loadApiLogs(job.id)}
                          loading={apiLogsLoading && selectedJobId === job.id}
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
                  {apiLogs.length} 条 API 日志
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

              {apiLogsLoading ? (
                <Text size="sm" c="dimmed">
                  加载中...
                </Text>
              ) : apiLogs.length > 0 ? (
                <ScrollArea h={400}>
                  <ScrollableTable striped highlightOnHover withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>时间</Table.Th>
                        <Table.Th>方法</Table.Th>
                        <Table.Th>URL</Table.Th>
                        <Table.Th>状态码</Table.Th>
                        <Table.Th>响应大小</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {apiLogs.map((log, idx) => (
                        <Table.Tr key={idx}>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {new Date(log.createdAt).toLocaleTimeString(
                                "zh-CN",
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                },
                              )}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge variant="outline" size="xs">
                              {log.method}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text
                              size="xs"
                              ff="monospace"
                              lineClamp={1}
                              style={{ maxWidth: 300 }}
                            >
                              {log.url}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              color={
                                log.statusCode >= 200 && log.statusCode < 300
                                  ? "green"
                                  : log.statusCode >= 300 &&
                                      log.statusCode < 400
                                    ? "yellow"
                                    : "red"
                              }
                              variant="light"
                              size="xs"
                            >
                              {log.statusCode}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {log.bodySize == null
                                ? "-"
                                : `${log.bodySize.toLocaleString()} B`}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </ScrollableTable>
                </ScrollArea>
              ) : (
                <Text size="sm" c="dimmed" ta="center">
                  暂无 API 调用日志（日志会在 24 小时后自动过期）
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
