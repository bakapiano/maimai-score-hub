import {
  Alert,
  Badge,
  Box,
  Card,
  Container,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { IconCloudUpload } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import { adminApi } from "../../api/appClient";
import { useAdminContext } from "./adminUtils";

type Totals = { success: number; failed: number; rate: number };
type TimelineBucket = {
  label: string;
  divingFish: { success: number; failed: number };
  lxns: { success: number; failed: number };
};
type TopFailure = {
  provider: string;
  message: string;
  count: number;
  lastSeenAt: string;
};
type RecentFailure = {
  jobId: string;
  friendCode: string;
  jobType: string;
  createdAt: string;
  divingFish: { status: string; message?: string } | null;
  lxns: { status: string; message?: string } | null;
};
type ProberExportMetrics = {
  window: "24h" | "7d";
  bucketMinutes: number;
  generatedAt: string;
  totals: { divingFish: Totals; lxns: Totals };
  timeline: TimelineBucket[];
  topFailures: TopFailure[];
  recentFailures: RecentFailure[];
};

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

function rateColor(r: number, denom: number): string | undefined {
  if (denom === 0) return undefined;
  if (r >= 95) return "green";
  if (r >= 80) return "yellow";
  return "red";
}

export default function AdminProberExportsPage() {
  const { password } = useAdminContext();
  const [window, setWindow] = useState<"24h" | "7d">("24h");
  const [data, setData] = useState<ProberExportMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getProberExportMetrics({
        headers: { "x-admin-password": password },
        query: { window },
      });
      if (res.status === 200) {
        setData(res.body as ProberExportMetrics);
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
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

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

  const dfTotal =
    data.totals.divingFish.success + data.totals.divingFish.failed;
  const lxTotal = data.totals.lxns.success + data.totals.lxns.failed;

  const chartData = data.timeline.map((b) => ({
    label: b.label,
    "水鱼-成功": b.divingFish.success,
    "水鱼-失败": b.divingFish.failed,
    "落雪-成功": b.lxns.success,
    "落雪-失败": b.lxns.failed,
  }));

  return (
    <Container size="xl" py="md">
      <Group justify="space-between" mb="md">
        <Group gap="xs">
          <IconCloudUpload size={24} />
          <Title order={2}>查分器导出监控</Title>
          <Badge variant="light" size="sm">
            {data.window}
          </Badge>
        </Group>
        <SegmentedControl
          value={window}
          onChange={(v) => setWindow(v as "24h" | "7d")}
          data={[
            { label: "近 24h (1h 桶)", value: "24h" },
            { label: "近 7d (6h 桶)", value: "7d" },
          ]}
          size="xs"
        />
      </Group>

      {/* KPI 行 */}
      <Group grow mb="md">
        <Kpi
          label="水鱼 成功率"
          value={dfTotal > 0 ? `${data.totals.divingFish.rate}%` : "—"}
          hint={`${data.totals.divingFish.success} ✓ / ${data.totals.divingFish.failed} ✗ (共 ${dfTotal})`}
          color={rateColor(data.totals.divingFish.rate, dfTotal)}
        />
        <Kpi
          label="落雪 成功率"
          value={lxTotal > 0 ? `${data.totals.lxns.rate}%` : "—"}
          hint={`${data.totals.lxns.success} ✓ / ${data.totals.lxns.failed} ✗ (共 ${lxTotal})`}
          color={rateColor(data.totals.lxns.rate, lxTotal)}
        />
      </Group>

      {/* 时序图 */}
      <Card withBorder padding="md" radius="md" mb="md">
        <Text size="sm" fw={500} mb="xs">
          导出时序（北京时间）
        </Text>
        {chartData.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            窗口内没有任何导出记录
          </Text>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="水鱼-成功" stackId="df" fill="#12b886" />
              <Bar dataKey="水鱼-失败" stackId="df" fill="#fa5252" />
              <Bar dataKey="落雪-成功" stackId="lx" fill="#228be6" />
              <Bar dataKey="落雪-失败" stackId="lx" fill="#fab005" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Top 错误 */}
      {data.topFailures.length > 0 && (
        <Card withBorder padding="md" radius="md" mb="md">
          <Text size="sm" fw={500} mb="sm">
            错误聚合（窗口内 top {data.topFailures.length}）
          </Text>
          <Stack gap={6}>
            {data.topFailures.map((f, i) => (
              <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
                <Badge
                  size="xs"
                  color={f.provider === "divingFish" ? "green" : "blue"}
                  variant="light"
                  style={{ minWidth: 50 }}
                >
                  {f.provider === "divingFish" ? "水鱼" : "落雪"}
                </Badge>
                <Badge size="xs" color="red" variant="light">
                  ×{f.count}
                </Badge>
                <Text
                  size="xs"
                  c="dimmed"
                  style={{
                    fontFamily: "monospace",
                    flex: 1,
                    wordBreak: "break-all",
                  }}
                >
                  {f.message}
                </Text>
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {new Date(f.lastSeenAt).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {/* 最近失败明细 */}
      {data.recentFailures.length > 0 && (
        <Card withBorder padding="md" radius="md" mb="md">
          <Text size="sm" fw={500} mb="sm">
            最近失败明细（最多 {data.recentFailures.length} 条）
          </Text>
          <Box style={{ overflowX: "auto" }}>
            <Table striped highlightOnHover withTableBorder fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>时间</Table.Th>
                  <Table.Th>FC</Table.Th>
                  <Table.Th>jobType</Table.Th>
                  <Table.Th>水鱼</Table.Th>
                  <Table.Th>落雪</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.recentFailures.map((r) => (
                  <Table.Tr key={r.jobId}>
                    <Table.Td>
                      {new Date(r.createdAt).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Table.Td>
                    <Table.Td style={{ fontFamily: "monospace" }}>
                      {r.friendCode}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color="gray">
                        {r.jobType}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {r.divingFish?.status === "failed" ? (
                        <Text
                          size="xs"
                          c="red"
                          style={{
                            fontFamily: "monospace",
                            wordBreak: "break-all",
                          }}
                        >
                          {(r.divingFish.message ?? "").slice(0, 80)}
                        </Text>
                      ) : r.divingFish?.status === "success" ? (
                        <Badge size="xs" color="green" variant="light">
                          ✓
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </Table.Td>
                    <Table.Td>
                      {r.lxns?.status === "failed" ? (
                        <Text
                          size="xs"
                          c="red"
                          style={{
                            fontFamily: "monospace",
                            wordBreak: "break-all",
                          }}
                        >
                          {(r.lxns.message ?? "").slice(0, 80)}
                        </Text>
                      ) : r.lxns?.status === "success" ? (
                        <Badge size="xs" color="green" variant="light">
                          ✓
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        </Card>
      )}

      <Text size="xs" c="dimmed" ta="right">
        生成于 {new Date(data.generatedAt).toLocaleString("zh-CN")} · 自动 30s
        刷新
      </Text>
    </Container>
  );
}
