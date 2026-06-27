import {
  ActionIcon,
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
  TextInput,
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
  IconCheck,
  IconClock,
  IconEdit,
  IconQrcode,
  IconRefresh,
  IconRobot,
  IconTrash,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useState } from "react";

import {
  type ActiveJobsStats,
  type BotStatus,
  type JobErrorStats,
  type JobStats,
  type JobTrend,
  useAdminContext,
} from "./adminUtils";
import { adminApi } from "../../api/appClient";
import { ScrollableTable } from "../../components/ScrollableTable";

export default function AdminActiveJobsPage() {
  const { password } = useAdminContext();

  // ── Active Jobs ──
  const [activeJobs, setActiveJobs] = useState<ActiveJobsStats | null>(null);
  const [activeJobsLoading, setActiveJobsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // ── Bot Status ──
  const [botStatuses, setBotStatuses] = useState<BotStatus[] | null>(null);
  const [botStatusesLoading, setBotStatusesLoading] = useState(false);
  const [editingRemark, setEditingRemark] = useState<string | null>(null);
  const [editRemarkValue, setEditRemarkValue] = useState("");

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

  // ── Cleanup ──
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);

  const handleCleanupJobs = useCallback(async () => {
    if (!password) return;
    if (!window.confirm("确定要清理 7 天前的所有任务记录吗？此操作不可撤销。"))
      return;
    setCleanupLoading(true);
    setCleanupResult(null);
    const res = await adminApi.cleanupJobs({
      headers: { "x-api-secret": password },
    });
    setCleanupLoading(false);
    if (res.status === 201) {
      setCleanupResult(`已清理 ${res.body.deletedCount} 条旧任务`);
    } else {
      setCleanupResult(`清理失败: HTTP ${res.status}`);
    }
  }, [password]);

  const saveRemark = useCallback(
    async (friendCode: string) => {
      if (!password) return;
      const remark = editRemarkValue.trim() || null;
      await adminApi.updateBotRemark({
        headers: { "x-api-secret": password },
        params: { friendCode },
        body: { remark },
      });
      setEditingRemark(null);
      // Update local state immediately
      setBotStatuses(
        (prev: BotStatus[] | null) =>
          prev?.map((b: BotStatus) =>
            b.friendCode === friendCode ? { ...b, remark } : b,
          ) ?? null,
      );
    },
    [password, editRemarkValue],
  );

  // ── Cabinet user-id edit / QR-bind ──
  const [editingCabinet, setEditingCabinet] = useState<string | null>(null);
  const [editCabinetValue, setEditCabinetValue] = useState("");
  const [cabinetBindBusy, setCabinetBindBusy] = useState<string | null>(null);

  const saveCabinetUserId = useCallback(
    async (friendCode: string) => {
      if (!password) return;
      const trimmed = editCabinetValue.trim();
      let cabinetUserId: number | null = null;
      if (trimmed) {
        if (!/^\d+$/.test(trimmed)) {
          notifications.show({
            color: "red",
            message: "cabinetUserId 必须是纯数字，留空表示清除",
          });
          return;
        }
        cabinetUserId = Number(trimmed);
      }
      const res = await fetch(
        `/api/v1/admin/bots/${encodeURIComponent(friendCode)}/cabinet-user-id`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-api-secret": password,
          },
          body: JSON.stringify({ cabinetUserId }),
        },
      );
      if (!res.ok) {
        notifications.show({
          color: "red",
          title: "保存失败",
          message: `HTTP ${res.status}`,
        });
        return;
      }
      setEditingCabinet(null);
      setBotStatuses(
        (prev) =>
          prev?.map((b) =>
            b.friendCode === friendCode ? { ...b, cabinetUserId } : b,
          ) ?? null,
      );
      notifications.show({ color: "green", message: "已保存" });
    },
    [password, editCabinetValue],
  );

  const removeBot = useCallback(
    async (friendCode: string) => {
      if (!password) return;
      if (
        !window.confirm(
          `确定删除 bot ${friendCode}？\n如该 bot worker 仍在运行，下次心跳（60s）会自动重新出现；只清理 admin UI 上的死残留。`,
        )
      )
        return;
      const res = await fetch(
        `/api/v1/admin/bots/${encodeURIComponent(friendCode)}`,
        {
          method: "DELETE",
          headers: { "x-api-secret": password },
        },
      );
      if (!res.ok) {
        notifications.show({
          color: "red",
          title: "删除失败",
          message: `HTTP ${res.status}`,
        });
        return;
      }
      setBotStatuses(
        (prev) => prev?.filter((b) => b.friendCode !== friendCode) ?? null,
      );
      notifications.show({
        color: "green",
        message: "已删除 bot",
      });
    },
    [password],
  );

  const bindCabinetByQr = useCallback(
    async (friendCode: string) => {
      if (!password) return;
      const qrCode = window.prompt(
        `请粘贴 bot ${friendCode} 卡牌上的 QR 字符串 (SGWCMAID...)`,
        "",
      );
      if (!qrCode || !qrCode.trim()) return;
      setCabinetBindBusy(friendCode);
      try {
        const res = await fetch(
          `/api/v1/admin/bots/${encodeURIComponent(friendCode)}/cabinet/bind-qr`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-secret": password,
            },
            body: JSON.stringify({ qrCode: qrCode.trim() }),
          },
        );
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) {
          notifications.show({
            color: "red",
            title: "绑定失败",
            message: json?.message ?? json?.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        setBotStatuses(
          (prev) =>
            prev?.map((b) =>
              b.friendCode === friendCode
                ? { ...b, cabinetUserId: json.cabinetUserId }
                : b,
            ) ?? null,
        );
        notifications.show({
          color: "green",
          title: "绑定成功",
          message: `cabinetUserId = ${json.cabinetUserId}`,
        });
      } catch (err) {
        notifications.show({
          color: "red",
          title: "绑定失败",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setCabinetBindBusy(null);
      }
    },
    [password],
  );

  // ── Loaders ──

  const loadActiveJobs = useCallback(async () => {
    if (!password) return;
    setActiveJobsLoading(true);
    const res = await adminApi.getActiveJobs({
      headers: { "x-api-secret": password },
    });
    setActiveJobsLoading(false);
    if (res.status === 200) {
      setActiveJobs((res.body as ActiveJobsStats) ?? null);
    }
  }, [password]);

  const loadBotStatuses = useCallback(async () => {
    if (!password) return;
    setBotStatusesLoading(true);
    const res = await adminApi.getBotStatus({
      headers: { "x-api-secret": password },
    });
    setBotStatusesLoading(false);
    if (res.status === 200) {
      setBotStatuses((res.body as BotStatus[]) ?? null);
    }
  }, [password]);

  const loadJobStats = useCallback(async () => {
    if (!password) return;
    setJobStatsLoading(true);
    const res = await adminApi.getJobStats({
      headers: { "x-api-secret": password },
    });
    setJobStatsLoading(false);
    if (res.status === 200) {
      setJobStats((res.body as JobStats) ?? null);
    }
  }, [password]);

  const loadJobTrend = useCallback(
    async (hours?: string) => {
      if (!password) return;
      setJobTrendLoading(true);
      const h = hours ?? trendHours;
      const res = await adminApi.getJobTrend({
        headers: { "x-api-secret": password },
        query: { hours: h },
      });
      setJobTrendLoading(false);
      if (res.status === 200) {
        setJobTrend((res.body as JobTrend) ?? null);
      }
    },
    [password, trendHours],
  );

  const loadJobErrorStats = useCallback(async () => {
    if (!password) return;
    setJobErrorStatsLoading(true);
    const res = await adminApi.getJobErrorStats({
      headers: { "x-api-secret": password },
    });
    setJobErrorStatsLoading(false);
    if (res.status === 200) {
      setJobErrorStats((res.body as JobErrorStats[]) ?? null);
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
      {/* ── 维护操作 ── */}
      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <IconTrash size={20} />
            <Text fw={600}>数据维护</Text>
            {cleanupResult && (
              <Text
                size="sm"
                c={cleanupResult.startsWith("已清理") ? "green" : "red"}
              >
                {cleanupResult}
              </Text>
            )}
          </Group>
          <Button
            variant="light"
            color="red"
            size="xs"
            leftSection={<IconTrash size={14} />}
            onClick={handleCleanupJobs}
            loading={cleanupLoading}
          >
            清理 7 天前的任务
          </Button>
        </Group>
      </Card>

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
            <ScrollableTable striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Bot 好友码</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th ta="right">好友数量</Table.Th>
                  <Table.Th>备注</Table.Th>
                  <Table.Th>Cabinet UserId</Table.Th>
                  <Table.Th>最近上报时间</Table.Th>
                  <Table.Th>操作</Table.Th>
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
                    <Table.Td ta="right">
                      <Text size="sm">
                        {bot.friendCount != null ? bot.friendCount : "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {editingRemark === bot.friendCode ? (
                        <Group gap="xs" wrap="nowrap">
                          <TextInput
                            size="xs"
                            value={editRemarkValue}
                            onChange={(e) =>
                              setEditRemarkValue(e.currentTarget.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                void saveRemark(bot.friendCode);
                              } else if (e.key === "Escape") {
                                setEditingRemark(null);
                              }
                            }}
                            style={{ flex: 1 }}
                            autoFocus
                          />
                          <ActionIcon
                            size="sm"
                            variant="light"
                            color="green"
                            onClick={() => void saveRemark(bot.friendCode)}
                          >
                            <IconCheck size={14} />
                          </ActionIcon>
                        </Group>
                      ) : (
                        <Group
                          gap="xs"
                          wrap="nowrap"
                          style={{ cursor: "pointer" }}
                          onClick={() => {
                            setEditingRemark(bot.friendCode);
                            setEditRemarkValue(bot.remark ?? "");
                          }}
                        >
                          <Text size="sm" c={bot.remark ? undefined : "dimmed"}>
                            {bot.remark || "-"}
                          </Text>
                          <ActionIcon size="xs" variant="subtle" color="gray">
                            <IconEdit size={12} />
                          </ActionIcon>
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {editingCabinet === bot.friendCode ? (
                        <Group gap="xs" wrap="nowrap">
                          <TextInput
                            size="xs"
                            placeholder="纯数字 / 留空清除"
                            value={editCabinetValue}
                            onChange={(e) =>
                              setEditCabinetValue(e.currentTarget.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                void saveCabinetUserId(bot.friendCode);
                              } else if (e.key === "Escape") {
                                setEditingCabinet(null);
                              }
                            }}
                            style={{ flex: 1, minWidth: 120 }}
                            autoFocus
                          />
                          <ActionIcon
                            size="sm"
                            variant="light"
                            color="green"
                            onClick={() =>
                              void saveCabinetUserId(bot.friendCode)
                            }
                          >
                            <IconCheck size={14} />
                          </ActionIcon>
                        </Group>
                      ) : (
                        <Group gap="xs" wrap="nowrap">
                          <Text
                            size="sm"
                            ff="monospace"
                            c={bot.cabinetUserId == null ? "dimmed" : undefined}
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setEditingCabinet(bot.friendCode);
                              setEditCabinetValue(
                                bot.cabinetUserId != null
                                  ? String(bot.cabinetUserId)
                                  : "",
                              );
                            }}
                          >
                            {bot.cabinetUserId ?? "-"}
                          </Text>
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color="gray"
                            title="手动编辑 cabinet userId"
                            onClick={() => {
                              setEditingCabinet(bot.friendCode);
                              setEditCabinetValue(
                                bot.cabinetUserId != null
                                  ? String(bot.cabinetUserId)
                                  : "",
                              );
                            }}
                          >
                            <IconEdit size={12} />
                          </ActionIcon>
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color="grape"
                            title="扫码绑定 cabinet"
                            loading={cabinetBindBusy === bot.friendCode}
                            onClick={() => void bindCabinetByQr(bot.friendCode)}
                          >
                            <IconQrcode size={12} />
                          </ActionIcon>
                        </Group>
                      )}
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
                    <Table.Td>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        title="删除 bot（worker 还活就会自己回来）"
                        onClick={() => void removeBot(bot.friendCode)}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </ScrollableTable>
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
            <ScrollableTable striped highlightOnHover withTableBorder>
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
            </ScrollableTable>
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
                <Tabs.Tab value="withUpdate">成绩更新</Tabs.Tab>
                <Tabs.Tab value="nonScoreUpdate">非成绩更新</Tabs.Tab>
                <Tabs.Tab value="errors">失败原因统计</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="withUpdate" pt="md">
                <ScrollableTable striped highlightOnHover withTableBorder>
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
                    {jobStats.scoreUpdate.map((row) => (
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
                </ScrollableTable>
              </Tabs.Panel>

              <Tabs.Panel value="nonScoreUpdate" pt="md">
                <ScrollableTable striped highlightOnHover withTableBorder>
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
                    {jobStats.nonScoreUpdate.map((row) => (
                      <Table.Tr key={row.label}>
                        <Table.Td>{row.label}</Table.Td>
                        <Table.Td ta="right">{row.totalCount}</Table.Td>
                        <Table.Td ta="right">{row.completedCount}</Table.Td>
                        <Table.Td ta="right">{row.failedCount}</Table.Td>
                        <Table.Td ta="right">{row.successRate}%</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </ScrollableTable>
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
                      <ScrollableTable striped highlightOnHover withTableBorder>
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
                      </ScrollableTable>
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
                        过去 {trendLabel} 成绩更新任务走势
                      </Text>
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart
                          data={jobTrend.scoreUpdate.map((row) => ({
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
                        过去 {trendLabel} 非成绩更新任务走势
                      </Text>
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart
                          data={jobTrend.nonScoreUpdate.map((row) => ({
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
                          data={jobTrend.scoreUpdate.map((row) => ({
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
