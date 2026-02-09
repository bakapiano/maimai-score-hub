import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  Pagination,
  ScrollArea,
  Select,
  Stack,
  Tooltip as MantineTooltip,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconBug,
  IconCode,
  IconExternalLink,
  IconEye,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import {
  adminFetch,
  useAdminContext,
  type ApiLogEntry,
  type SearchJobResult,
} from "./adminUtils";

export default function AdminJobDebugPage() {
  const { password } = useAdminContext();

  const [friendCode, setFriendCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [jobs, setJobs] = useState<SearchJobResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [apiLogs, setApiLogs] = useState<ApiLogEntry[]>([]);
  const [apiLogsLoading, setApiLogsLoading] = useState(false);

  const [responseViewerOpen, setResponseViewerOpen] = useState(false);
  const [responseViewerContent, setResponseViewerContent] = useState("");
  const [responseViewerRenderHtml, setResponseViewerRenderHtml] =
    useState(true);
  const [responseViewerUrl, setResponseViewerUrl] = useState("");

  const searchJobs = useCallback(
    async (p = 1) => {
      if (!password) return;
      setLoading(true);
      const params = new URLSearchParams();
      if (friendCode.trim()) {
        params.set("friendCode", friendCode.trim());
      }
      if (status) {
        params.set("status", status);
      }
      params.set("page", String(p));
      params.set("pageSize", "10");
      const res = await adminFetch<{
        data: SearchJobResult[];
        total: number;
        page: number;
        pageSize: number;
      }>(`/api/admin/jobs?${params.toString()}`, password);
      setLoading(false);
      if (res.ok && res.data) {
        setJobs(res.data.data);
        setTotal(res.data.total);
        setPage(res.data.page);
      }
    },
    [password, friendCode, status],
  );

  const loadApiLogs = useCallback(
    async (jobId: string) => {
      if (!password) return;
      setSelectedJobId(jobId);
      setApiLogsLoading(true);
      const res = await adminFetch<ApiLogEntry[]>(
        `/api/admin/jobs/${jobId}/api-logs`,
        password,
      );
      setApiLogsLoading(false);
      if (res.ok && res.data) {
        setApiLogs(res.data);
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
            <Table striped highlightOnHover withTableBorder>
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
                {jobs.map((job) => (
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
                      <Text
                        size="sm"
                        c={job.error ? "red" : "dimmed"}
                        lineClamp={1}
                        style={{ maxWidth: 200 }}
                      >
                        {job.error ?? "-"}
                      </Text>
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
            </Table>
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
                  API 调用日志 (Job: {selectedJobId.slice(0, 8)}...)
                </Text>
                <Badge variant="light" size="sm">
                  {apiLogs.length} 条记录
                </Badge>
              </Group>

              {apiLogsLoading ? (
                <Text size="sm" c="dimmed">
                  加载中...
                </Text>
              ) : apiLogs.length > 0 ? (
                <ScrollArea h={400}>
                  <Table striped highlightOnHover withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>时间</Table.Th>
                        <Table.Th>方法</Table.Th>
                        <Table.Th>URL</Table.Th>
                        <Table.Th>状态码</Table.Th>
                        <Table.Th>响应</Table.Th>
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
                            {log.responseBody ? (
                              <Group gap={4} wrap="nowrap">
                                <Code
                                  block
                                  style={{
                                    maxHeight: 60,
                                    overflow: "hidden",
                                    maxWidth: 200,
                                    fontSize: 10,
                                  }}
                                >
                                  {log.responseBody.slice(0, 200)}
                                  {log.responseBody.length > 200 ? "..." : ""}
                                </Code>
                                <Stack gap={2}>
                                  <MantineTooltip label="查看完整响应">
                                    <ActionIcon
                                      variant="subtle"
                                      size="xs"
                                      onClick={() => {
                                        setResponseViewerContent(
                                          log.responseBody ?? "",
                                        );
                                        setResponseViewerUrl(log.url);
                                        setResponseViewerRenderHtml(
                                          log.responseBody
                                            ?.trimStart()
                                            .startsWith("<") ?? false,
                                        );
                                        setResponseViewerOpen(true);
                                      }}
                                    >
                                      <IconEye size={14} />
                                    </ActionIcon>
                                  </MantineTooltip>
                                  <MantineTooltip label="新窗口打开">
                                    <ActionIcon
                                      variant="subtle"
                                      size="xs"
                                      onClick={() => {
                                        const w = window.open("", "_blank");
                                        if (w) {
                                          w.document.write(
                                            log.responseBody ?? "",
                                          );
                                          w.document.close();
                                        }
                                      }}
                                    >
                                      <IconExternalLink size={14} />
                                    </ActionIcon>
                                  </MantineTooltip>
                                </Stack>
                              </Group>
                            ) : (
                              <Text size="xs" c="dimmed">
                                -
                              </Text>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
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

        <Modal
          opened={responseViewerOpen}
          onClose={() => setResponseViewerOpen(false)}
          title={
            <Group gap="sm">
              <Text fw={600} size="sm">
                响应内容
              </Text>
              <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>
                {responseViewerUrl}
              </Text>
            </Group>
          }
          size="90vw"
          styles={{
            body: { padding: 0 },
            header: { padding: "8px 16px" },
          }}
        >
          <Group
            gap="xs"
            px="md"
            py={6}
            style={{
              borderBottom: "1px solid var(--mantine-color-default-border)",
            }}
          >
            <Button
              variant={responseViewerRenderHtml ? "filled" : "light"}
              size="xs"
              leftSection={<IconEye size={14} />}
              onClick={() => setResponseViewerRenderHtml(true)}
            >
              渲染 HTML
            </Button>
            <Button
              variant={!responseViewerRenderHtml ? "filled" : "light"}
              size="xs"
              leftSection={<IconCode size={14} />}
              onClick={() => setResponseViewerRenderHtml(false)}
            >
              源代码
            </Button>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconExternalLink size={14} />}
              onClick={() => {
                const w = window.open("", "_blank");
                if (w) {
                  w.document.write(responseViewerContent);
                  w.document.close();
                }
              }}
            >
              新窗口打开
            </Button>
          </Group>
          {responseViewerRenderHtml ? (
            <iframe
              srcDoc={responseViewerContent}
              style={{
                width: "100%",
                height: "75vh",
                border: "none",
              }}
              sandbox="allow-same-origin"
              title="Response HTML Preview"
            />
          ) : (
            <ScrollArea h="75vh" p="md">
              <Code
                block
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  fontSize: 12,
                }}
              >
                {responseViewerContent}
              </Code>
            </ScrollArea>
          )}
        </Modal>
      </Stack>
    </Card>
  );
}
