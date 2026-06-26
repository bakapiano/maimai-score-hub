import {
  Alert,
  Badge,
  Box,
  Card,
  Container,
  Grid,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Switch,
  Text,
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
import { IconClock } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import { adminApi } from "../../api/appClient";
import { useAdminContext } from "./adminUtils";

// ── Types ──

type TimelineBucket = {
  bucketStart: string;
  triggered: number;
  skipped: number;
  failed: number;
  sweepCount: number;
  completedJobs: number;
  avgDurationMs: number | null;
  p50Ms: number | null;
  p99Ms: number | null;
  rateLimit567: number;
};

type AutoUpdateMetrics = {
  window: "24h" | "7d";
  bucketMinutes: number;
  generatedAt: string;
  timeline: TimelineBucket[];
  now: {
    autoUpdateUsers: number;
    queued: number;
    processing: number;
    perBotInflight: { friendCode: string; count: number }[];
    activeCabinetBots: number;
  };
  optimization: {
    sampleSize: number;
    cabinetHitRate: number;
    diffSkipHitRate: number;
    avgDiffsScraped: number | null;
    estimatedReqsPerJob: number;
  };
  capacity: {
    activeCabinetBots: number;
    reqsPerMinPerBot: number;
    estimatedJobsPerMin: number;
    estimatedJobsPerSweep: number;
    triggerRatePerUserPerSweep: number;
    peakFactor: number;
    maxUsersAvg: number | null;
    maxUsersPeak: number | null;
    currentUtilization: number | null;
  };
  summary: {
    totalTriggered: number;
    totalSkipped: number;
    totalSweepCount: number;
    total567: number;
  };
};

// ── helpers ──

function fmtBucketLabel(iso: string, window: "24h" | "7d"): string {
  const d = new Date(iso);
  if (window === "24h") {
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });
}

// Reusable KPI card
function Kpi({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  color?: string;
}) {
  return (
    <Card withBorder padding="md" radius="md" h="100%">
      <Stack gap={4}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={500}>
          {label}
        </Text>
        <Text size="xl" fw={700} c={color}>
          {value}
        </Text>
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

export default function AdminAutoUpdatePage() {
  const { password } = useAdminContext();
  const [window, setWindow] = useState<"24h" | "7d">("24h");
  const [data, setData] = useState<AutoUpdateMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cabinetOnlyMode, setCabinetOnlyMode] = useState<boolean | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    if (!password) return;
    try {
      const res = await adminApi.getSystemSettings({
        headers: { "x-api-secret": password },
      });
      if (res.status === 200) {
        setCabinetOnlyMode(res.body.cabinetOnlyMode);
        setSettingsError(null);
      } else {
        setSettingsError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  }, [password]);

  const toggleCabinetOnly = useCallback(
    async (next: boolean) => {
      if (!password || settingsBusy) return;
      const prev = cabinetOnlyMode;
      setCabinetOnlyMode(next); // optimistic
      setSettingsBusy(true);
      setSettingsError(null);
      try {
        const res = await adminApi.updateSystemSettings({
          headers: { "x-api-secret": password },
          body: { cabinetOnlyMode: next },
        });
        if (res.status === 200) {
          setCabinetOnlyMode(res.body.cabinetOnlyMode);
        } else {
          setCabinetOnlyMode(prev);
          setSettingsError(`HTTP ${res.status}`);
        }
      } catch (err) {
        setCabinetOnlyMode(prev);
        setSettingsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingsBusy(false);
      }
    },
    [password, cabinetOnlyMode, settingsBusy],
  );

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getAutoUpdateMetrics({
        headers: { "x-api-secret": password },
        query: { window },
      });
      if (res.status === 200) {
        setData(res.body as AutoUpdateMetrics);
      } else {
        setError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [password, window]);

  useEffect(() => {
    void load();
    void loadSettings();
    // refresh every 30s for live snapshot
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load, loadSettings]);

  if (!data && loading) {
    return (
      <Container py="md">
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      </Container>
    );
  }

  if (error) {
    return (
      <Container py="md">
        <Alert color="red" title="加载失败">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!data) return null;

  // Chart data
  const chartData = data.timeline.map((b) => ({
    label: fmtBucketLabel(b.bucketStart, data.window),
    triggered: b.triggered,
    skipped: b.skipped,
    failed: b.failed,
    rateLimit567: b.rateLimit567,
    p50Sec: b.p50Ms != null ? Math.round(b.p50Ms / 100) / 10 : null,
    p99Sec: b.p99Ms != null ? Math.round(b.p99Ms / 100) / 10 : null,
    avgSec:
      b.avgDurationMs != null ? Math.round(b.avgDurationMs / 100) / 10 : null,
  }));

  const utilColor =
    data.capacity.currentUtilization == null
      ? undefined
      : data.capacity.currentUtilization < 50
        ? "green"
        : data.capacity.currentUtilization < 80
          ? "yellow"
          : "red";

  return (
    <Container size="xl" py="md">
      <Group justify="space-between" mb="md">
        <Group gap="xs">
          <IconClock size={24} />
          <Title order={2}>自动更新监控</Title>
          <Badge variant="light" size="sm">
            {data.window}
          </Badge>
        </Group>
        <SegmentedControl
          value={window}
          onChange={(v) => setWindow(v as "24h" | "7d")}
          data={[
            { label: "近 24h (5min 桶)", value: "24h" },
            { label: "近 7d (1h 桶)", value: "7d" },
          ]}
          size="xs"
        />
      </Group>

      {/* ── Cabinet-only mode toggle ── */}
      <Card withBorder padding="md" radius="md" mb="md">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Box style={{ flex: 1 }}>
            <Group gap="xs" mb={4}>
              <Text fw={600}>Cabinet-only 模式</Text>
              {cabinetOnlyMode === true && (
                <Badge color="orange" variant="filled" size="sm">
                  ON
                </Badge>
              )}
            </Group>
            <Text size="sm" c="dimmed">
              ON 时所有绑定机台的用户更新（自动 + 手动 update_score）跳过 DXNet
              worker，直接用 sdgb 机台数据写入 score；fc/fs 保留上次值不刷新。
              未绑定机台的用户不受影响，仍走 worker。
            </Text>
            {settingsError && (
              <Text size="xs" c="red" mt={4}>
                {settingsError}
              </Text>
            )}
          </Box>
          <Switch
            size="lg"
            checked={cabinetOnlyMode === true}
            disabled={cabinetOnlyMode === null || settingsBusy}
            onChange={(e) => void toggleCabinetOnly(e.currentTarget.checked)}
          />
        </Group>
      </Card>

      {/* ── KPI 行 ── */}
      <Grid gutter="md" mb="md">
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="自动更新用户"
            value={data.now.autoUpdateUsers}
            hint={`活跃 cabinet bot ${data.now.activeCabinetBots}`}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="容量上限 (峰值估算)"
            value={data.capacity.maxUsersPeak ?? "—"}
            hint={`平均估算 ${data.capacity.maxUsersAvg ?? "—"}`}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="当前利用率"
            value={
              data.capacity.currentUtilization != null
                ? `${data.capacity.currentUtilization}%`
                : "—"
            }
            hint={`peak factor ${data.capacity.peakFactor}×`}
            color={utilColor}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="排队中 / 进行中"
            value={`${data.now.queued} / ${data.now.processing}`}
            hint={`per bot: ${
              data.now.perBotInflight.length > 0
                ? data.now.perBotInflight
                    .map((p) => `${p.friendCode.slice(-4)}=${p.count}`)
                    .join(" ")
                : "空"
            }`}
          />
        </Grid.Col>
      </Grid>

      <Grid gutter="md" mb="md">
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="窗口内 triggered"
            value={data.summary.totalTriggered}
            hint={`${data.summary.totalSweepCount} 次 sweep`}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="窗口内 skipped"
            value={data.summary.totalSkipped}
            hint="hash 未变 / 节流"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="窗口内 567 限流"
            value={data.summary.total567}
            hint="撞 server 天花板的次数"
            color={data.summary.total567 > 100 ? "red" : "green"}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, md: 3 }}>
          <Kpi
            label="cabinet 优化命中率"
            value={`${data.optimization.cabinetHitRate}%`}
            hint={`平均 ${data.optimization.estimatedReqsPerJob} req/job · diff-skip ${data.optimization.diffSkipHitRate}%`}
          />
        </Grid.Col>
      </Grid>

      {/* ── 图表 1: sweep 时序 ── */}
      <Card withBorder padding="md" radius="md" mb="md">
        <Text size="sm" fw={500} mb="xs">
          Sweep 时序（每{data.bucketMinutes}min triggered / skipped / failed）
        </Text>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              interval="preserveStartEnd"
            />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar
              dataKey="triggered"
              stackId="a"
              fill="#12b886"
              name="triggered"
            />
            <Bar dataKey="skipped" stackId="a" fill="#adb5bd" name="skipped" />
            <Bar dataKey="failed" stackId="a" fill="#fa5252" name="failed" />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* ── 图表 2: 567 + duration ── */}
      <Grid gutter="md" mb="md">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card withBorder padding="md" radius="md">
            <Text size="sm" fw={500} mb="xs">
              567 限流次数（次 / 桶）
            </Text>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="rateLimit567" fill="#fab005" name="567" />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card withBorder padding="md" radius="md">
            <Text size="sm" fw={500} mb="xs">
              Job 完成耗时趋势（秒）
            </Text>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="p50Sec"
                  stroke="#228be6"
                  name="p50"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="p99Sec"
                  stroke="#fa5252"
                  name="p99"
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="avgSec"
                  stroke="#12b886"
                  name="avg"
                  dot={false}
                  strokeDasharray="4 4"
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </Grid.Col>
      </Grid>

      {/* ── 容量诊断 ── */}
      <Card withBorder padding="md" radius="md" mb="md">
        <Text size="sm" fw={500} mb="sm">
          容量诊断
        </Text>
        <Grid gutter="sm">
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Box>
              <Text size="xs" c="dimmed">
                理论吞吐
              </Text>
              <Text size="sm">
                {data.capacity.activeCabinetBots} bot ×{" "}
                {data.capacity.reqsPerMinPerBot} req/min ÷{" "}
                {data.optimization.estimatedReqsPerJob} req/job ≈{" "}
                <b>{data.capacity.estimatedJobsPerMin} job/min</b>
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                每 5min sweep 间隔可消化 {data.capacity.estimatedJobsPerSweep}{" "}
                个 job
              </Text>
            </Box>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Box>
              <Text size="xs" c="dimmed">
                触发模型
              </Text>
              <Text size="sm">
                每用户每 sweep 触发率 ≈{" "}
                <b>
                  {(data.capacity.triggerRatePerUserPerSweep * 100).toFixed(2)}%
                </b>{" "}
                · peak/avg = <b>{data.capacity.peakFactor}×</b>
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                平均承受 {data.capacity.maxUsersAvg ?? "—"} user · 峰值安全
                (×0.7) {data.capacity.maxUsersPeak ?? "—"} user
              </Text>
            </Box>
          </Grid.Col>
        </Grid>
      </Card>

      <Text size="xs" c="dimmed" ta="right">
        生成于 {new Date(data.generatedAt).toLocaleString("zh-CN")} · 自动 30s
        刷新 · sample {data.optimization.sampleSize} 个最近 idle job
      </Text>
    </Container>
  );
}
