import {
  Badge,
  Button,
  Card,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
} from "@mantine/core";
import {
  Bar,
  BarChart,
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
  IconChartBar,
  IconClock,
  IconRefresh,
  IconRobot,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import {
  adminFetch,
  useAdminContext,
  type ActiveJobsStats,
  type BotStatus,
  type JobErrorStats,
  type JobStats,
  type JobTrend,
} from "./adminUtils";

export default function AdminActiveJobsPage() {
  const { password } = useAdminContext();

  // ── Active Jobs ──
  const [activeJobs, setActiveJobs] = useState<ActiveJobsStats | null>(null);
  const [activeJobsLoading, setActiveJobsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // ── Bot Status ──
  const [botStatuses, setBotStatuses] = useState<BotStatus[] | null>(null);
  const [botStatusesLoading, setBotStatusesLoading] = useState(false);

  // ── Job Stats ──
  const [jobStats, setJobStats] = useState<JobStats | null>(null);
  const [jobStatsLoading, setJobStatsLoading] = useState(false);

  const [jobTrend, setJobTrend] = useState<JobTrend | null>(null);
  const [jobTrendLoading, setJobTrendLoading] = useState(false);
  const [trendHours, setTrendHours] = useState("24");

  const [jobErrorStats, setJobErrorStats] = useState<JobErrorStats[] | null>(
    null,
  );
  const [jobErrorStatsLoading, setJobErrorStatsLoading] = useState(false);
  const [selectedErrorTimeRange, setSelectedErrorTimeRange] = useState(0);

  // ── Loaders ──

  const loadActiveJobs = useCallback(async () => {
    if (!password) return;
    setActiveJobsLoading(true);
    const res = await adminFetch<ActiveJobsStats>(
      "/api/admin/active-jobs",
      password,
    );
    setActiveJobsLoading(false);
    if (res.ok && res.data) {
      setActiveJobs(res.data);
    }
  }, [password]);

  const loadBotStatuses = useCallback(async () => {
    if (!password) return;
    setBotStatusesLoading(true);
    const res = await adminFetch<BotStatus[]>(
      "/api/admin/bot-status",
      password,
    );
    setBotStatusesLoading(false);
    if (res.ok && res.data) {
      setBotStatuses(res.data);
    }
  }, [password]);

  const loadJobStats = useCallback(async () => {
    if (!password) return;
    setJobStatsLoading(true);
    const res = await adminFetch<JobStats>("/api/admin/job-stats", password);
    setJobStatsLoading(false);
    if (res.ok) {
      setJobStats(res.data ?? null);
    }
  }, [password]);

  const loadJobTrend = useCallback(
    async (hours?: string) => {
      if (!password) return;
      setJobTrendLoading(true);
      const h = hours ?? trendHours;
      const res = await adminFetch<JobTrend>(
        `/api/admin/job-trend?hours=${h}`,
        password,
      );
      setJobTrendLoading(false);
      if (res.ok) {
        setJobTrend(res.data ?? null);
      }
    },
    [password, trendHours],
  );

  const loadJobErrorStats = useCallback(async () => {
    if (!password) return;
    setJobErrorStatsLoading(true);
    const res = await adminFetch<JobErrorStats[]>(
      "/api/admin/job-error-stats",
      password,
    );
    setJobErrorStatsLoading(false);
    if (res.ok) {
      setJobErrorStats(res.data ?? null);
    }
  }, [password]);

  // ── Effects ──

  useEffect(() => {
    if (password && !activeJobs) void loadActiveJobs();
  }, [password, activeJobs, loadActiveJobs]);

  useEffect(() => {
    if (password && !botStatuses) void loadBotStatuses();
  }, [password, botStatuses, loadBotStatuses]);

  useEffect(() => {
    if (password && !jobStats) void loadJobStats();
  }, [password, jobStats, loadJobStats]);

  useEffect(() => {
    if (password && !jobTrend) void loadJobTrend();
  }, [password, jobTrend, loadJobTrend]);

  useEffect(() => {
    if (password && !jobErrorStats) void loadJobErrorStats();
  }, [password, jobErrorStats, loadJobErrorStats]);

  // Auto refresh active jobs & bot statuses every 5s
  useEffect(() => {
    if (!password || !autoRefresh) return;
    const interval = setInterval(() => {
      void loadActiveJobs();
      void loadBotStatuses();
    }, 5000);
    return () => clearInterval(interval);
  }, [password, autoRefresh, loadActiveJobs, loadBotStatuses]);

  // ── Trend helpers ──

  function formatTrendLabel(hourStr: string) {
    const d = new Date(hourStr);
    const h = Number(trendHours);
    if (h > 168) {
      return d.toLocaleDateString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
      });
    }
    if (h > 48) {
      return (
        d.toLocaleDateString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
        }) +
        " " +
        d.toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    }
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const trendLabel =
    trendHours === "24"
      ? "24 小时"
      : trendHours === "48"
        ? "48 小时"
        : trendHours === "168"
          ? "7 天"
          : "30 天";

  return (
    <Stack gap="lg">
      {/* ── Bot 状态 ── */}
      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Group gap="xs">
              <IconRobot size={20} />
              <Text fw={600}>Bot 状态</Text>
              {botStatuses && (
                <Group gap="xs">
                  <Badge color="green" variant="light">
                    可用: {botStatuses.filter((b) => b.available).length}
                  </Badge>
                  <Badge color="red" variant="light">
                    不可用: {botStatuses.filter((b) => !b.available).length}
                  </Badge>
                </Group>
              )}
            </Group>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              onClick={loadBotStatuses}
              loading={botStatusesLoading}
            >
              刷新
            </Button>
          </Group>

          {botStatuses && botStatuses.length > 0 ? (
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Bot 好友码</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>最近上报时间</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {botStatuses.map((bot) => (
                  <Table.Tr key={bot.friendCode}>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {bot.friendCode}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={bot.available ? "green" : "red"}
                        variant="light"
                        size="sm"
                      >
                        {bot.available ? "可用" : "不可用"}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(bot.lastReportedAt).toLocaleString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="sm" c="dimmed" ta="center">
              {botStatusesLoading ? "加载中..." : "暂无 Bot 状态数据"}
            </Text>
          )}
        </Stack>
      </Card>

      {/* ── 实时任务监控 ── */}
      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Group gap="xs">
              <IconClock size={20} />
              <Text fw={600}>实时任务监控</Text>
              {activeJobs && (
                <Group gap="xs">
                  <Badge color="yellow" variant="light">
                    排队: {activeJobs.queuedCount}
                  </Badge>
                  <Badge color="blue" variant="light">
                    进行中: {activeJobs.processingCount}
                  </Badge>
                </Group>
              )}
            </Group>
            <Group gap="xs">
              <Switch
                size="xs"
                label="自动刷新"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
              />
              <Button
                variant="light"
                size="xs"
                leftSection={<IconRefresh size={14} />}
                onClick={loadActiveJobs}
                loading={activeJobsLoading}
              >
                刷新
              </Button>
            </Group>
          </Group>

          {activeJobs && activeJobs.jobs.length > 0 ? (
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>好友码</Table.Th>
                  <Table.Th>Bot</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>阶段</Table.Th>
                  <Table.Th>进度</Table.Th>
                  <Table.Th ta="right">运行时长</Table.Th>
                  <Table.Th>创建时间</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {activeJobs.jobs.map((job) => (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {job.friendCode}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace" c="dimmed">
                        {job.botUserFriendCode ?? "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={job.status === "processing" ? "blue" : "yellow"}
                        variant="light"
                        size="sm"
                      >
                        {job.status === "queued"
                          ? "排队中"
                          : job.executing
                            ? "执行中"
                            : "处理中"}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {job.stage === "send_request"
                          ? "发送请求"
                          : job.stage === "wait_acceptance"
                            ? "等待接受"
                            : job.stage === "update_score"
                              ? "更新分数"
                              : job.stage}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {job.scoreProgress ? (
                        <Text size="sm">
                          {job.scoreProgress.completedDiffs.length}/
                          {job.scoreProgress.totalDiffs}
                        </Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          -
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" ff="monospace">
                        {Math.floor(job.runningDuration / 1000)}s
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(job.createdAt).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="sm" c="dimmed" ta="center">
              {activeJobsLoading ? "加载中..." : "当前没有进行中的任务"}
            </Text>
          )}
        </Stack>
      </Card>

      {/* ── 任务统计 ── */}
      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Group gap="xs">
              <IconChartBar size={20} />
              <Text fw={600}>任务统计</Text>
            </Group>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              onClick={loadJobStats}
              loading={jobStatsLoading}
            >
              刷新
            </Button>
          </Group>

          {jobStats ? (
            <Tabs defaultValue="charts">
              <Tabs.List>
                <Tabs.Tab value="charts">图表</Tabs.Tab>
                <Tabs.Tab value="withUpdate">包含分数更新</Tabs.Tab>
                <Tabs.Tab value="skipUpdate">跳过分数更新</Tabs.Tab>
                <Tabs.Tab value="errors">失败原因统计</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="withUpdate" pt="md">
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>时间范围</Table.Th>
                      <Table.Th ta="right">总数</Table.Th>
                      <Table.Th ta="right">成功</Table.Th>
                      <Table.Th ta="right">失败</Table.Th>
                      <Table.Th ta="right">成功率</Table.Th>
                      <Table.Th ta="right">平均耗时</Table.Th>
                      <Table.Th ta="right">最短耗时</Table.Th>
                      <Table.Th ta="right">最长耗时</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {jobStats.withUpdateScore.map((row) => (
                      <Table.Tr key={row.label}>
                        <Table.Td>{row.label}</Table.Td>
                        <Table.Td ta="right">{row.totalCount}</Table.Td>
                        <Table.Td ta="right">{row.completedCount}</Table.Td>
                        <Table.Td ta="right">{row.failedCount}</Table.Td>
                        <Table.Td ta="right">{row.successRate}%</Table.Td>
                        <Table.Td ta="right">
                          {row.avgDuration != null
                            ? `${(row.avgDuration / 1000).toFixed(1)}s`
                            : "-"}
                        </Table.Td>
                        <Table.Td ta="right">
                          {row.minDuration != null
                            ? `${(row.minDuration / 1000).toFixed(1)}s`
                            : "-"}
                        </Table.Td>
                        <Table.Td ta="right">
                          {row.maxDuration != null
                            ? `${(row.maxDuration / 1000).toFixed(1)}s`
                            : "-"}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Tabs.Panel>

              <Tabs.Panel value="skipUpdate" pt="md">
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>时间范围</Table.Th>
                      <Table.Th ta="right">总数</Table.Th>
                      <Table.Th ta="right">成功</Table.Th>
                      <Table.Th ta="right">失败</Table.Th>
                      <Table.Th ta="right">成功率</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {jobStats.skipUpdateScore.map((row) => (
                      <Table.Tr key={row.label}>
                        <Table.Td>{row.label}</Table.Td>
                        <Table.Td ta="right">{row.totalCount}</Table.Td>
                        <Table.Td ta="right">{row.completedCount}</Table.Td>
                        <Table.Td ta="right">{row.failedCount}</Table.Td>
                        <Table.Td ta="right">{row.successRate}%</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Tabs.Panel>

              <Tabs.Panel value="errors" pt="md">
                {jobErrorStats && jobErrorStats.length > 0 ? (
                  <Stack gap="md">
                    <Group gap="xs">
                      {jobErrorStats.map((range, idx) => (
                        <Button
                          key={range.label}
                          variant={
                            selectedErrorTimeRange === idx ? "filled" : "light"
                          }
                          size="xs"
                          onClick={() => setSelectedErrorTimeRange(idx)}
                        >
                          {range.label}
                        </Button>
                      ))}
                    </Group>
                    {(jobErrorStats[selectedErrorTimeRange]?.items?.length ??
                      0) > 0 ? (
                      <Table striped highlightOnHover withTableBorder>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>错误信息</Table.Th>
                            <Table.Th ta="right" w={100}>
                              次数
                            </Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {jobErrorStats[selectedErrorTimeRange]?.items.map(
                            (row, idx) => (
                              <Table.Tr key={idx}>
                                <Table.Td>
                                  <Text
                                    size="sm"
                                    style={{ wordBreak: "break-all" }}
                                  >
                                    {row.error}
                                  </Text>
                                </Table.Td>
                                <Table.Td ta="right">{row.count}</Table.Td>
                              </Table.Tr>
                            ),
                          )}
                        </Table.Tbody>
                      </Table>
                    ) : (
                      <Text size="sm" c="dimmed" ta="center">
                        该时间段内暂无失败记录
                      </Text>
                    )}
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed" ta="center">
                    {jobErrorStatsLoading ? "加载中..." : "暂无失败记录"}
                  </Text>
                )}
              </Tabs.Panel>

              <Tabs.Panel value="charts" pt="md">
                {jobTrend ? (
                  <Stack gap="lg">
                    <Group justify="space-between" align="center">
                      <Text size="sm" fw={500}>
                        时间范围
                      </Text>
                      <SegmentedControl
                        size="xs"
                        value={trendHours}
                        onChange={(val) => {
                          setTrendHours(val);
                          void loadJobTrend(val);
                        }}
                        data={[
                          { label: "24小时", value: "24" },
                          { label: "48小时", value: "48" },
                          { label: "7天", value: "168" },
                          { label: "30天", value: "720" },
                        ]}
                      />
                    </Group>
                    <div>
                      <Text size="sm" fw={500} mb="xs">
                        过去 {trendLabel} 包含分数更新任务走势
                      </Text>
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart
                          data={jobTrend.withUpdateScore.map((row) => ({
                            hour: formatTrendLabel(row.hour),
                            成功: row.completedCount,
                            失败: row.failedCount,
                          }))}
                        >
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis
                            dataKey="hour"
                            tick={{ fontSize: 11 }}
                            interval="preserveStartEnd"
                          />
                          <YAxis allowDecimals={false} />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="成功" stackId="a" fill="#12b886" />
                          <Bar dataKey="失败" stackId="a" fill="#fa5252" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    <div>
                      <Text size="sm" fw={500} mb="xs">
                        过去 {trendLabel} 跳过分数更新任务走势
                      </Text>
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart
                          data={jobTrend.skipUpdateScore.map((row) => ({
                            hour: formatTrendLabel(row.hour),
                            成功: row.completedCount,
                            失败: row.failedCount,
                          }))}
                        >
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis
                            dataKey="hour"
                            tick={{ fontSize: 11 }}
                            interval="preserveStartEnd"
                          />
                          <YAxis allowDecimals={false} />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="成功" stackId="a" fill="#12b886" />
                          <Bar dataKey="失败" stackId="a" fill="#fa5252" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    <div>
                      <Text size="sm" fw={500} mb="xs">
                        过去 {trendLabel} 更新分数耗时走势 (秒)
                      </Text>
                      <ResponsiveContainer width="100%" height={280}>
                        <LineChart
                          data={jobTrend.withUpdateScore.map((row) => ({
                            hour: formatTrendLabel(row.hour),
                            平均耗时:
                              row.avgDuration != null
                                ? Number((row.avgDuration / 1000).toFixed(1))
                                : null,
                          }))}
                        >
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis
                            dataKey="hour"
                            tick={{ fontSize: 11 }}
                            interval="preserveStartEnd"
                          />
                          <YAxis />
                          <Tooltip formatter={(value) => `${value}s`} />
                          <Legend />
                          <Line
                            type="monotone"
                            dataKey="平均耗时"
                            stroke="#228be6"
                            strokeWidth={2}
                            connectNulls
                            dot={{ r: 3 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed" ta="center">
                    {jobTrendLoading ? "加载中..." : "暂无走势数据"}
                  </Text>
                )}
              </Tabs.Panel>
            </Tabs>
          ) : (
            <Text size="sm" c="dimmed" ta="center">
              {jobStatsLoading ? "加载中..." : "暂无任务统计数据"}
            </Text>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
