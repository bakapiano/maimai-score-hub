import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Group,
  Tooltip as MantineTooltip,
  Modal,
  Pagination,
  PasswordInput,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
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
  IconArrowsExchange,
  IconBug,
  IconChartBar,
  IconClock,
  IconCode,
  IconDatabase,
  IconExternalLink,
  IconEye,
  IconMusic,
  IconPhoto,
  IconRefresh,
  IconRobot,
  IconUsers,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface BotStatus {
  friendCode: string;
  available: boolean;
  lastReportedAt: string;
}

interface AdminStats {
  userCount: number;
  musicCount: number;
  syncCount: number;
  coverCount: number;
}

interface JobStatsTimeRange {
  label: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
}

interface JobStatsWithDuration extends JobStatsTimeRange {
  avgDuration: number | null;
  minDuration: number | null;
  maxDuration: number | null;
}

interface JobStats {
  skipUpdateScore: JobStatsTimeRange[];
  withUpdateScore: JobStatsWithDuration[];
}

interface JobTrendPoint {
  hour: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  avgDuration: number | null;
}

interface JobTrend {
  skipUpdateScore: JobTrendPoint[];
  withUpdateScore: JobTrendPoint[];
}

interface JobErrorStatsItem {
  error: string;
  count: number;
}

interface JobErrorStats {
  label: string;
  items: JobErrorStatsItem[];
}

interface ActiveJob {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  executing: boolean;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  createdAt: string;
  updatedAt: string;
  pickedAt: string | null;
  runningDuration: number;
}

interface ActiveJobsStats {
  queuedCount: number;
  processingCount: number;
  jobs: ActiveJob[];
}

interface AdminUser {
  id: string;
  friendCode: string;
  username: string | null;
  rating: number | null;
  createdAt: string;
  updatedAt: string;
}

interface SearchJobResult {
  id: string;
  friendCode: string;
  skipUpdateScore: boolean;
  botUserFriendCode: string | null;
  status: string;
  stage: string;
  error: string | null;
  executing: boolean;
  scoreProgress: { completedDiffs: number[]; totalDiffs: number } | null;
  updateScoreDuration: number | null;
  createdAt: string;
  updatedAt: string;
  pickedAt: string | null;
}

interface ApiLogEntry {
  url: string;
  method: string;
  statusCode: number;
  responseBody: string | null;
  createdAt: string;
}

const ADMIN_PASSWORD_KEY = "admin_password";

function useAdminPassword() {
  const [password, setPassword] = useState<string>(() => {
    try {
      return localStorage.getItem(ADMIN_PASSWORD_KEY) || "";
    } catch {
      return "";
    }
  });

  const savePassword = useCallback((pwd: string) => {
    setPassword(pwd);
    try {
      if (pwd) {
        localStorage.setItem(ADMIN_PASSWORD_KEY, pwd);
      } else {
        localStorage.removeItem(ADMIN_PASSWORD_KEY);
      }
    } catch {
      // ignore
    }
  }, []);

  return { password, savePassword };
}

async function adminFetch<T>(
  url: string,
  password: string,
  options?: RequestInit,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        "X-Admin-Password": password,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export default function AdminPage() {
  const { password, savePassword } = useAdminPassword();
  const [inputPassword, setInputPassword] = useState(password);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");

  // Stats are fetched but currently not displayed in UI
  const [_stats, setStats] = useState<AdminStats | null>(null);
  const [_statsLoading, setStatsLoading] = useState(false);

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

  const [coverSyncing, setCoverSyncing] = useState(false);
  const [coverSyncResult, setCoverSyncResult] = useState<string>("");

  const [musicSyncing, setMusicSyncing] = useState(false);
  const [musicSyncResult, setMusicSyncResult] = useState<string>("");

  const [dataSource, setDataSource] = useState<"diving-fish" | "lxns" | null>(
    null,
  );
  const [dataSourceLoading, setDataSourceLoading] = useState(false);
  const [dataSourceSwitching, setDataSourceSwitching] = useState(false);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userPage, setUserPage] = useState(1);
  const usersPerPage = 20;

  const [activeJobs, setActiveJobs] = useState<ActiveJobsStats | null>(null);
  const [activeJobsLoading, setActiveJobsLoading] = useState(false);
  const [autoRefreshActiveJobs, setAutoRefreshActiveJobs] = useState(true);

  const [botStatuses, setBotStatuses] = useState<BotStatus[] | null>(null);
  const [botStatusesLoading, setBotStatusesLoading] = useState(false);

  // Job Debug state
  const [debugFriendCode, setDebugFriendCode] = useState("");
  const [debugStatus, setDebugStatus] = useState<string | null>(null);
  const [debugJobs, setDebugJobs] = useState<SearchJobResult[]>([]);
  const [debugJobsLoading, setDebugJobsLoading] = useState(false);
  const [debugJobsPage, setDebugJobsPage] = useState(1);
  const [debugJobsTotal, setDebugJobsTotal] = useState(0);
  const [debugSelectedJobId, setDebugSelectedJobId] = useState<string | null>(
    null,
  );
  const [debugApiLogs, setDebugApiLogs] = useState<ApiLogEntry[]>([]);
  const [debugApiLogsLoading, setDebugApiLogsLoading] = useState(false);
  const [responseViewerOpen, setResponseViewerOpen] = useState(false);
  const [responseViewerContent, setResponseViewerContent] = useState("");
  const [responseViewerRenderHtml, setResponseViewerRenderHtml] =
    useState(true);
  const [responseViewerUrl, setResponseViewerUrl] = useState("");

  const paginatedUsers = useMemo(() => {
    const start = (userPage - 1) * usersPerPage;
    return users.slice(start, start + usersPerPage);
  }, [users, userPage]);

  const totalUserPages = useMemo(
    () => Math.ceil(users.length / usersPerPage),
    [users.length],
  );

  const verifyPassword = useCallback(async () => {
    if (!inputPassword.trim()) {
      setError("请输入管理员密码");
      return;
    }
    setVerifying(true);
    setError("");

    const res = await adminFetch<AdminStats>(
      "/api/admin/stats",
      inputPassword.trim(),
    );
    setVerifying(false);

    if (res.ok) {
      savePassword(inputPassword.trim());
      setVerified(true);
      setStats(res.data ?? null);
    } else {
      setError(res.error || "验证失败");
    }
  }, [inputPassword, savePassword]);

  const loadStats = useCallback(async () => {
    if (!password) return;
    setStatsLoading(true);
    const res = await adminFetch<AdminStats>("/api/admin/stats", password);
    setStatsLoading(false);
    if (res.ok) {
      setStats(res.data ?? null);
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

  const syncCovers = useCallback(async () => {
    if (!password) return;
    setCoverSyncing(true);
    setCoverSyncResult("");
    const res = await adminFetch<{
      ok: boolean;
      total: number;
      saved: number;
      skipped: number;
      failed: number;
    }>("/api/admin/sync-covers", password, { method: "POST" });
    setCoverSyncing(false);
    if (res.ok && res.data) {
      setCoverSyncResult(
        `完成: 总计 ${res.data.total}, 保存 ${res.data.saved}, 跳过 ${res.data.skipped}, 失败 ${res.data.failed}`,
      );
      void loadStats();
    } else {
      setCoverSyncResult(`失败: ${res.error}`);
    }
  }, [password, loadStats]);

  const syncMusic = useCallback(async () => {
    if (!password) return;
    setMusicSyncing(true);
    setMusicSyncResult("");
    const res = await adminFetch<{
      ok: boolean;
      total: number;
      added: number;
      updated: number;
    }>("/api/admin/sync-music", password, { method: "POST" });
    setMusicSyncing(false);
    if (res.ok && res.data) {
      setMusicSyncResult(
        `完成: 总计 ${res.data.total}, 新增 ${res.data.added}, 更新 ${res.data.updated}`,
      );
      void loadStats();
    } else {
      setMusicSyncResult(`失败: ${res.error}`);
    }
  }, [password, loadStats]);

  const loadDataSource = useCallback(async () => {
    setDataSourceLoading(true);
    try {
      const res = await fetch("/api/music/source");
      if (res.ok) {
        const data = await res.json();
        setDataSource(data.source);
      }
    } catch {
      // ignore
    }
    setDataSourceLoading(false);
  }, []);

  const switchDataSource = useCallback(
    async (newSource: "diving-fish" | "lxns") => {
      if (!password) return;
      setDataSourceSwitching(true);
      const res = await adminFetch<{ ok: boolean; source: string }>(
        "/api/music/source",
        password,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: newSource }),
        },
      );
      setDataSourceSwitching(false);
      if (res.ok && res.data) {
        setDataSource(res.data.source as "diving-fish" | "lxns");
      }
    },
    [password],
  );

  const loadUsers = useCallback(async () => {
    if (!password) return;
    setUsersLoading(true);
    const res = await adminFetch<AdminUser[]>("/api/admin/users", password);
    setUsersLoading(false);
    if (res.ok && res.data) {
      setUsers(res.data);
      setUserPage(1);
    }
  }, [password]);

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

  const searchDebugJobs = useCallback(
    async (page = 1) => {
      if (!password) return;
      setDebugJobsLoading(true);
      const params = new URLSearchParams();
      if (debugFriendCode.trim()) {
        params.set("friendCode", debugFriendCode.trim());
      }
      if (debugStatus) {
        params.set("status", debugStatus);
      }
      params.set("page", String(page));
      params.set("pageSize", "10");
      const res = await adminFetch<{
        data: SearchJobResult[];
        total: number;
        page: number;
        pageSize: number;
      }>(`/api/admin/jobs?${params.toString()}`, password);
      setDebugJobsLoading(false);
      if (res.ok && res.data) {
        setDebugJobs(res.data.data);
        setDebugJobsTotal(res.data.total);
        setDebugJobsPage(res.data.page);
      }
    },
    [password, debugFriendCode, debugStatus],
  );

  const loadDebugApiLogs = useCallback(
    async (jobId: string) => {
      if (!password) return;
      setDebugSelectedJobId(jobId);
      setDebugApiLogsLoading(true);
      const res = await adminFetch<ApiLogEntry[]>(
        `/api/admin/jobs/${jobId}/api-logs`,
        password,
      );
      setDebugApiLogsLoading(false);
      if (res.ok && res.data) {
        setDebugApiLogs(res.data);
      } else {
        setDebugApiLogs([]);
      }
    },
    [password],
  );

  // Auto verify if password is stored
  useEffect(() => {
    if (password && !verified) {
      setInputPassword(password);
      (async () => {
        setVerifying(true);
        const res = await adminFetch<AdminStats>("/api/admin/stats", password);
        setVerifying(false);
        if (res.ok) {
          setVerified(true);
          setStats(res.data ?? null);
        }
      })();
    }
  }, [password, verified]);

  // Load users when verified
  useEffect(() => {
    if (verified && password && users.length === 0) {
      void loadUsers();
    }
  }, [verified, password, users.length, loadUsers]);

  // Load job stats when verified
  useEffect(() => {
    if (verified && password && !jobStats) {
      void loadJobStats();
    }
  }, [verified, password, jobStats, loadJobStats]);

  // Load job trend when verified
  useEffect(() => {
    if (verified && password && !jobTrend) {
      void loadJobTrend();
    }
  }, [verified, password, jobTrend, loadJobTrend]);

  // Load job error stats when verified
  useEffect(() => {
    if (verified && password && !jobErrorStats) {
      void loadJobErrorStats();
    }
  }, [verified, password, jobErrorStats, loadJobErrorStats]);

  // Load data source when verified
  useEffect(() => {
    if (verified && dataSource === null) {
      void loadDataSource();
    }
  }, [verified, dataSource, loadDataSource]);

  // Load active jobs when verified
  useEffect(() => {
    if (verified && password && !activeJobs) {
      void loadActiveJobs();
    }
  }, [verified, password, activeJobs, loadActiveJobs]);

  // Load bot statuses when verified
  useEffect(() => {
    if (verified && password && !botStatuses) {
      void loadBotStatuses();
    }
  }, [verified, password, botStatuses, loadBotStatuses]);

  // Auto refresh active jobs every 5 seconds
  useEffect(() => {
    if (!verified || !password || !autoRefreshActiveJobs) return;
    const interval = setInterval(() => {
      void loadActiveJobs();
      void loadBotStatuses();
    }, 5000);
    return () => clearInterval(interval);
  }, [
    verified,
    password,
    autoRefreshActiveJobs,
    loadActiveJobs,
    loadBotStatuses,
  ]);

  if (!verified) {
    return (
      <Container size="xs" py="xl">
        <Card withBorder shadow="sm" padding="xl" radius="md">
          <Stack gap="md">
            <Title order={3} ta="center">
              管理员登录
            </Title>
            <PasswordInput
              label="管理员密码"
              placeholder="输入密码"
              value={inputPassword}
              onChange={(e) => setInputPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void verifyPassword();
                }
              }}
            />
            {error && (
              <Text size="sm" c="red">
                {error}
              </Text>
            )}
            <Button onClick={verifyPassword} loading={verifying} fullWidth>
              登录
            </Button>
          </Stack>
        </Card>
      </Container>
    );
  }

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" align="center">
          <Title order={3}>管理后台</Title>
          <Button
            variant="subtle"
            size="xs"
            onClick={() => {
              savePassword("");
              setVerified(false);
              setInputPassword("");
            }}
          >
            退出
          </Button>
        </Group>

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
                          {new Date(bot.lastReportedAt).toLocaleString(
                            "zh-CN",
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            },
                          )}
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

        <Card withBorder shadow="sm" padding="lg" radius="md">
          <Group gap="xs" mb="md">
            <IconArrowsExchange size={20} />
            <Text fw={600}>数据同步</Text>
          </Group>
          <Group gap="md">
            <div>
              <Group gap="sm" mb={4}>
                <Button
                  variant="light"
                  leftSection={<IconPhoto size={16} />}
                  onClick={syncCovers}
                  loading={coverSyncing}
                >
                  同步封面
                </Button>
              </Group>
              {coverSyncResult && (
                <Text size="sm" c="dimmed">
                  {coverSyncResult}
                </Text>
              )}
            </div>

            <div>
              <Group gap="sm" mb={4}>
                <Button
                  variant="light"
                  leftSection={<IconMusic size={16} />}
                  onClick={syncMusic}
                  loading={musicSyncing}
                >
                  同步歌曲数据
                </Button>
              </Group>
              {musicSyncResult && (
                <Text size="sm" c="dimmed">
                  {musicSyncResult}
                </Text>
              )}
            </div>
          </Group>
        </Card>

        <Card withBorder shadow="sm" padding="lg" radius="md">
          <Group gap="xs" mb="md">
            <IconDatabase size={20} />
            <Text fw={600}>歌曲数据源</Text>
          </Group>
          <Group gap="md" align="center">
            <Group gap="xs">
              <Text size="sm" c="dimmed">
                当前数据源:
              </Text>
              {dataSourceLoading ? (
                <Text size="sm">加载中...</Text>
              ) : (
                <Text size="sm" fw={600}>
                  {dataSource === "diving-fish"
                    ? "Diving-Fish (水鱼)"
                    : dataSource === "lxns"
                      ? "落雪 (LXNS)"
                      : "未知"}
                </Text>
              )}
            </Group>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              onClick={loadDataSource}
              loading={dataSourceLoading}
            >
              刷新
            </Button>
            <Button
              variant={dataSource === "diving-fish" ? "filled" : "outline"}
              size="xs"
              onClick={() => switchDataSource("diving-fish")}
              loading={dataSourceSwitching}
              disabled={dataSource === "diving-fish"}
            >
              Diving-Fish
            </Button>
            <Button
              variant={dataSource === "lxns" ? "filled" : "outline"}
              size="xs"
              onClick={() => switchDataSource("lxns")}
              loading={dataSourceSwitching}
              disabled={dataSource === "lxns"}
            >
              落雪 (LXNS)
            </Button>
          </Group>
        </Card>

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
                  checked={autoRefreshActiveJobs}
                  onChange={(e) =>
                    setAutoRefreshActiveJobs(e.currentTarget.checked)
                  }
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
                          color={
                            job.status === "processing" ? "blue" : "yellow"
                          }
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
                              selectedErrorTimeRange === idx
                                ? "filled"
                                : "light"
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
                          过去{" "}
                          {trendHours === "24"
                            ? "24 小时"
                            : trendHours === "48"
                              ? "48 小时"
                              : trendHours === "168"
                                ? "7 天"
                                : "30 天"}{" "}
                          包含分数更新任务走势
                        </Text>
                        <ResponsiveContainer width="100%" height={280}>
                          <BarChart
                            data={jobTrend.withUpdateScore.map((row) => {
                              const d = new Date(row.hour);
                              const h = Number(trendHours);
                              const label =
                                h > 168
                                  ? d.toLocaleDateString("zh-CN", {
                                      month: "2-digit",
                                      day: "2-digit",
                                    })
                                  : h > 48
                                    ? d.toLocaleDateString("zh-CN", {
                                        month: "2-digit",
                                        day: "2-digit",
                                      }) +
                                      " " +
                                      d.toLocaleTimeString("zh-CN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : d.toLocaleTimeString("zh-CN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      });
                              return {
                                hour: label,
                                成功: row.completedCount,
                                失败: row.failedCount,
                              };
                            })}
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
                          过去{" "}
                          {trendHours === "24"
                            ? "24 小时"
                            : trendHours === "48"
                              ? "48 小时"
                              : trendHours === "168"
                                ? "7 天"
                                : "30 天"}{" "}
                          跳过分数更新任务走势
                        </Text>
                        <ResponsiveContainer width="100%" height={280}>
                          <BarChart
                            data={jobTrend.skipUpdateScore.map((row) => {
                              const d = new Date(row.hour);
                              const h = Number(trendHours);
                              const label =
                                h > 168
                                  ? d.toLocaleDateString("zh-CN", {
                                      month: "2-digit",
                                      day: "2-digit",
                                    })
                                  : h > 48
                                    ? d.toLocaleDateString("zh-CN", {
                                        month: "2-digit",
                                        day: "2-digit",
                                      }) +
                                      " " +
                                      d.toLocaleTimeString("zh-CN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : d.toLocaleTimeString("zh-CN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      });
                              return {
                                hour: label,
                                成功: row.completedCount,
                                失败: row.failedCount,
                              };
                            })}
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
                            <Bar dataKey="成功" stackId="a" fill="#15aabf" />
                            <Bar dataKey="失败" stackId="a" fill="#fd7e14" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      <div>
                        <Text size="sm" fw={500} mb="xs">
                          过去{" "}
                          {trendHours === "24"
                            ? "24 小时"
                            : trendHours === "48"
                              ? "48 小时"
                              : trendHours === "168"
                                ? "7 天"
                                : "30 天"}{" "}
                          更新分数耗时走势 (秒)
                        </Text>
                        <ResponsiveContainer width="100%" height={280}>
                          <LineChart
                            data={jobTrend.withUpdateScore.map((row) => {
                              const d = new Date(row.hour);
                              const h = Number(trendHours);
                              const label =
                                h > 168
                                  ? d.toLocaleDateString("zh-CN", {
                                      month: "2-digit",
                                      day: "2-digit",
                                    })
                                  : h > 48
                                    ? d.toLocaleDateString("zh-CN", {
                                        month: "2-digit",
                                        day: "2-digit",
                                      }) +
                                      " " +
                                      d.toLocaleTimeString("zh-CN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : d.toLocaleTimeString("zh-CN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      });
                              return {
                                hour: label,
                                平均耗时:
                                  row.avgDuration != null
                                    ? Number(
                                        (row.avgDuration / 1000).toFixed(1),
                                      )
                                    : null,
                              };
                            })}
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
                value={debugFriendCode}
                onChange={(e) => setDebugFriendCode(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <Select
                label="状态"
                placeholder="全部"
                size="sm"
                clearable
                value={debugStatus}
                onChange={setDebugStatus}
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
                onClick={() => searchDebugJobs(1)}
                loading={debugJobsLoading}
              >
                搜索
              </Button>
            </Group>

            {debugJobs.length > 0 && (
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
                    {debugJobs.map((job) => (
                      <Table.Tr
                        key={job.id}
                        bg={
                          debugSelectedJobId === job.id
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
                            onClick={() => loadDebugApiLogs(job.id)}
                            loading={
                              debugApiLogsLoading &&
                              debugSelectedJobId === job.id
                            }
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
                    共 {debugJobsTotal} 条记录
                  </Text>
                  <Pagination
                    value={debugJobsPage}
                    onChange={(p) => searchDebugJobs(p)}
                    total={Math.ceil(debugJobsTotal / 10)}
                    size="sm"
                  />
                </Group>
              </>
            )}

            {debugSelectedJobId && (
              <Card withBorder padding="md" radius="sm">
                <Stack gap="sm">
                  <Group justify="space-between" align="center">
                    <Text fw={600} size="sm">
                      API 调用日志 (Job: {debugSelectedJobId.slice(0, 8)}...)
                    </Text>
                    <Badge variant="light" size="sm">
                      {debugApiLogs.length} 条记录
                    </Badge>
                  </Group>

                  {debugApiLogsLoading ? (
                    <Text size="sm" c="dimmed">
                      加载中...
                    </Text>
                  ) : debugApiLogs.length > 0 ? (
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
                          {debugApiLogs.map((log, idx) => (
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
                                    log.statusCode >= 200 &&
                                    log.statusCode < 300
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
                                      {log.responseBody.length > 200
                                        ? "..."
                                        : ""}
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

            {!debugJobsLoading && debugJobs.length === 0 && (
              <Text size="sm" c="dimmed" ta="center">
                输入好友码或选择状态后点击搜索
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

        <Card withBorder shadow="sm" padding="lg" radius="md">
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Group gap="xs">
                <IconUsers size={20} />
                <Text fw={600}>用户列表 ({users.length})</Text>
              </Group>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconRefresh size={14} />}
                onClick={loadUsers}
                loading={usersLoading}
              >
                刷新
              </Button>
            </Group>

            {users.length > 0 ? (
              <>
                <Table striped highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>好友码</Table.Th>
                      <Table.Th>用户名</Table.Th>
                      <Table.Th>Rating</Table.Th>
                      <Table.Th>注册时间</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {paginatedUsers.map((user) => (
                      <Table.Tr key={user.id}>
                        <Table.Td>
                          <Text size="sm" ff="monospace">
                            {user.friendCode}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{user.username ?? "-"}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{user.rating ?? "-"}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {new Date(user.createdAt).toLocaleString("zh-CN", {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>

                {totalUserPages > 1 && (
                  <Group justify="center">
                    <Pagination
                      total={totalUserPages}
                      value={userPage}
                      onChange={setUserPage}
                      size="sm"
                    />
                  </Group>
                )}
              </>
            ) : (
              <Text size="sm" c="dimmed" ta="center">
                {usersLoading ? "加载中..." : "暂无用户数据"}
              </Text>
            )}
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}
