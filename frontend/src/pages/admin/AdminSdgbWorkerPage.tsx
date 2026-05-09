import {
  Badge,
  Button,
  Card,
  Group,
  Pagination,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconBolt, IconRefresh, IconRobot } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdminContext } from "./adminUtils";

interface SdgbRecentJob {
  id: string;
  jobType: "scan_qr" | "get_rival_hash" | "add_rival";
  status: "queued" | "processing" | "completed" | "failed";
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  requesterTag: string | null;
  createdAt: string;
  updatedAt: string;
  ageSeconds: number;
  durationMs: number | null;
}

interface SdgbWorkerStatusResponse {
  workers: Array<{
    workerId: string;
    lastSeenAt: string;
    ageSeconds: number;
    jobsClaimed: number;
    alive: boolean;
  }>;
  queue: {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  };
  byType: Array<{
    jobType: SdgbRecentJob["jobType"];
    queued: number;
    processing: number;
    completedLastHour: number;
    failedLastHour: number;
  }>;
  oldestQueuedAgeSeconds: number | null;
  oldestProcessingAgeSeconds: number | null;
  recentJobs: SdgbRecentJob[];
}

interface SdgbJobListResponse {
  items: SdgbRecentJob[];
  total: number;
  page: number;
  pageSize: number;
}

interface AutoUpdateUserRow {
  friendCode: string;
  cabinetUserId: number | null;
  lastScoreHash: string | null;
  preferredBotFriendCode: string | null;
  lastIdleJob: {
    id: string;
    botUserFriendCode: string | null;
    status: string;
    stage: string;
    createdAt: string;
    updatedAt: string;
    error: string | null;
  } | null;
  lastHashJob: {
    id: string;
    status: string;
    result: Record<string, unknown> | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
}

const POLL_INTERVAL_MS = 5_000;

const JOB_TYPE_LABEL: Record<SdgbRecentJob["jobType"], string> = {
  scan_qr: "扫码",
  get_rival_hash: "拉成绩 hash",
  add_rival: "加好友",
};

const STATUS_COLOR: Record<SdgbRecentJob["status"], string> = {
  queued: "gray",
  processing: "blue",
  completed: "green",
  failed: "red",
};

function fmtAge(seconds: number | null): string {
  if (seconds == null) return "-";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin ? `${hours}h${restMin}m` : `${hours}h`;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function payloadSummary(job: SdgbRecentJob): string {
  const p = job.payload ?? {};
  switch (job.jobType) {
    case "scan_qr":
      return `qrCode=${String(p.qrCode ?? "").slice(-12)}`;
    case "get_rival_hash":
      return `cabinetUserId=${p.cabinetUserId ?? "?"}`;
    case "add_rival":
      return `bot=${p.botCabinetUserId ?? "?"} → target=${p.targetCabinetUserId ?? "?"}`;
    default:
      return "";
  }
}

function resultSummary(job: SdgbRecentJob): string {
  if (job.status === "failed") return job.error ?? "failed";
  if (!job.result) return "—";
  const r = job.result;
  switch (job.jobType) {
    case "scan_qr":
      return `cabinetUserId=${r.cabinetUserId ?? "?"} hash=${String(r.hash ?? "").slice(0, 8)}…`;
    case "get_rival_hash":
      return `hash=${String(r.hash ?? "").slice(0, 8)}…`;
    case "add_rival":
      return `rc1=${r.returnCode1 ?? "?"} rc2=${r.returnCode2 ?? "?"}`;
    default:
      return "";
  }
}

export default function AdminSdgbWorkerPage() {
  const { password } = useAdminContext();
  const [data, setData] = useState<SdgbWorkerStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  // ── Manual trigger by friendCode ──
  const [triggerFc, setTriggerFc] = useState("");
  const [triggerBusy, setTriggerBusy] = useState(false);

  const triggerByFriendCode = useCallback(async () => {
    const fc = triggerFc.trim();
    if (!/^\d+$/.test(fc)) {
      notifications.show({
        color: "red",
        message: "friendCode 必须是纯数字",
      });
      return;
    }
    setTriggerBusy(true);
    try {
      const res = await fetch(`/api/auto-update/trigger/${fc}`, {
        method: "POST",
        headers: { "x-admin-password": password },
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const msg =
          json?.message ?? json?.error ?? `HTTP ${res.status}`;
        notifications.show({ color: "red", title: "触发失败", message: msg });
        return;
      }
      notifications.show({
        color: "green",
        title: "已触发",
        message: `bot=${json?.bot?.friendCode ?? "?"} jobId=${json?.jobId ?? "?"}`,
      });
      setTriggerFc("");
    } catch (err) {
      notifications.show({
        color: "red",
        title: "触发失败",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTriggerBusy(false);
    }
  }, [triggerFc, password]);

  const load = useCallback(async () => {
    if (!password) return;
    setLoading(true);
    setError(null);
    try {
      // Not in shared/ts-rest contract — small admin-only endpoint, hit it
      // directly with fetch to keep the change footprint small.
      const res = await fetch("/api/admin/sdgb-worker/status", {
        headers: { "x-admin-password": password },
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as SdgbWorkerStatusResponse;
      if (cancelled.current) return;
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [password]);

  // ── Paginated job list ──
  const [jobsList, setJobsList] = useState<SdgbJobListResponse | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [filterTag, setFilterTag] = useState("");
  // Debounced tag value to avoid hammering the backend on every keystroke.
  const [filterTagDebounced, setFilterTagDebounced] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setFilterTagDebounced(filterTag), 300);
    return () => window.clearTimeout(id);
  }, [filterTag]);

  const [jobsPage, setJobsPage] = useState(1);
  const pageSize = 20;
  // Reset to page 1 when filters change.
  useEffect(() => {
    setJobsPage(1);
  }, [filterType, filterStatus, filterTagDebounced]);

  const loadJobs = useCallback(async () => {
    if (!password) return;
    setJobsLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterType) params.set("jobType", filterType);
      if (filterStatus) params.set("status", filterStatus);
      if (filterTagDebounced.trim()) params.set("tag", filterTagDebounced.trim());
      params.set("page", String(jobsPage));
      params.set("pageSize", String(pageSize));
      const res = await fetch(
        `/api/admin/sdgb-worker/jobs?${params.toString()}`,
        { headers: { "x-admin-password": password } },
      );
      if (!res.ok) return;
      const body = (await res.json()) as SdgbJobListResponse;
      if (cancelled.current) return;
      setJobsList(body);
    } finally {
      setJobsLoading(false);
    }
  }, [password, filterType, filterStatus, filterTagDebounced, jobsPage]);

  useEffect(() => {
    void loadJobs();
    const id = window.setInterval(loadJobs, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [loadJobs]);

  const totalJobsPages = useMemo(
    () => (jobsList ? Math.max(1, Math.ceil(jobsList.total / pageSize)) : 1),
    [jobsList],
  );

  // ── auto-update users overview ──
  const [autoUsers, setAutoUsers] = useState<AutoUpdateUserRow[] | null>(null);
  const [autoUsersLoading, setAutoUsersLoading] = useState(false);

  const loadAutoUsers = useCallback(async () => {
    if (!password) return;
    setAutoUsersLoading(true);
    try {
      const res = await fetch("/api/auto-update/users", {
        headers: { "x-admin-password": password },
      });
      if (!res.ok) return;
      const body = (await res.json()) as AutoUpdateUserRow[];
      if (cancelled.current) return;
      setAutoUsers(body);
    } finally {
      setAutoUsersLoading(false);
    }
  }, [password]);

  useEffect(() => {
    void loadAutoUsers();
    const id = window.setInterval(loadAutoUsers, POLL_INTERVAL_MS * 2);
    return () => window.clearInterval(id);
  }, [loadAutoUsers]);

  useEffect(() => {
    cancelled.current = false;
    void load();
    const id = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      window.clearInterval(id);
    };
  }, [load]);

  return (
    <Stack gap="md">
      <Card withBorder shadow="sm" padding="lg" radius="md">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <IconRobot size={20} />
            <Text fw={600}>sdgb-worker 状态</Text>
            <Text size="xs" c="dimmed">
              每 {POLL_INTERVAL_MS / 1000}s 自动刷新
            </Text>
          </Group>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            onClick={load}
            loading={loading}
          >
            立即刷新
          </Button>
        </Group>
        {error && (
          <Text size="sm" c="red" mt="sm">
            加载失败: {error}
          </Text>
        )}
      </Card>

      <Card withBorder padding="md" radius="md">
        <Stack gap="xs">
          <Group gap="xs">
            <IconBolt size={18} />
            <Text fw={600} size="sm">
              强制触发自动更新（按 friendCode）
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            跳过 hash 比对，直接为该用户走一次：addRival + 创建{" "}
            <code>idle_update_score</code> job。需要该用户已绑定 cabinetUserId。
          </Text>
          <Group>
            <TextInput
              placeholder="目标用户 friendCode (纯数字)"
              value={triggerFc}
              onChange={(e) => setTriggerFc(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !triggerBusy) {
                  void triggerByFriendCode();
                }
              }}
              style={{ flex: 1 }}
            />
            <Button
              leftSection={<IconBolt size={14} />}
              loading={triggerBusy}
              disabled={!triggerFc.trim()}
              onClick={triggerByFriendCode}
            >
              触发更新
            </Button>
          </Group>
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <Card withBorder padding="md" radius="md">
          <Stack gap="xs">
            <Text fw={600} size="sm">
              Worker 心跳
            </Text>
            {data?.workers.length === 0 || !data ? (
              <Text size="sm" c="dimmed">
                暂无 worker 上报，请确认 sdgb-worker 已启动并能访问 backend
              </Text>
            ) : (
              <Stack gap={4}>
                {data.workers.map((w) => (
                  <Group key={w.workerId} justify="space-between">
                    <Group gap={6}>
                      <Badge color={w.alive ? "green" : "red"} variant="light">
                        {w.alive ? "alive" : "stale"}
                      </Badge>
                      <Text size="sm" fw={500}>
                        {w.workerId}
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      {fmtAge(w.ageSeconds)} 前 · 累计{" "}
                      {w.jobsClaimed} 任务
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Stack>
        </Card>

        <Card withBorder padding="md" radius="md">
          <Stack gap="xs">
            <Text fw={600} size="sm">
              队列概览
            </Text>
            {data && (
              <Group gap="md">
                <Group gap={4}>
                  <Badge color="gray" variant="light">
                    queued
                  </Badge>
                  <Text fw={600}>{data.queue.queued}</Text>
                </Group>
                <Group gap={4}>
                  <Badge color="blue" variant="light">
                    processing
                  </Badge>
                  <Text fw={600}>{data.queue.processing}</Text>
                </Group>
                <Group gap={4}>
                  <Badge color="green" variant="light">
                    completed
                  </Badge>
                  <Text fw={600}>{data.queue.completed}</Text>
                </Group>
                <Group gap={4}>
                  <Badge color="red" variant="light">
                    failed
                  </Badge>
                  <Text fw={600}>{data.queue.failed}</Text>
                </Group>
              </Group>
            )}
            {data && (
              <Group gap="md" mt={4}>
                <Text size="xs" c="dimmed">
                  最久排队: {fmtAge(data.oldestQueuedAgeSeconds)}
                </Text>
                <Text size="xs" c="dimmed">
                  最久执行中: {fmtAge(data.oldestProcessingAgeSeconds)}
                </Text>
              </Group>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      <Card withBorder padding="md" radius="md">
        <Stack gap="xs">
          <Text fw={600} size="sm">
            按 jobType 统计 (近 1 小时)
          </Text>
          <Table withTableBorder withColumnBorders highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>类型</Table.Th>
                <Table.Th>queued</Table.Th>
                <Table.Th>processing</Table.Th>
                <Table.Th>completed (1h)</Table.Th>
                <Table.Th>failed (1h)</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data?.byType.map((row) => (
                <Table.Tr key={row.jobType}>
                  <Table.Td>{JOB_TYPE_LABEL[row.jobType]}</Table.Td>
                  <Table.Td>{row.queued}</Table.Td>
                  <Table.Td>{row.processing}</Table.Td>
                  <Table.Td>{row.completedLastHour}</Table.Td>
                  <Table.Td>
                    {row.failedLastHour > 0 ? (
                      <Text c="red" fw={600} component="span">
                        {row.failedLastHour}
                      </Text>
                    ) : (
                      0
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      </Card>

      <Card withBorder padding="md" radius="md">
        <Stack gap="xs">
          <Group justify="space-between" align="center" wrap="wrap">
            <Text fw={600} size="sm">
              所有任务
              {jobsList && (
                <Text component="span" size="xs" c="dimmed" ml={6}>
                  共 {jobsList.total} 条
                </Text>
              )}
            </Text>
            <Group gap="xs" wrap="wrap">
              <Select
                size="xs"
                placeholder="类型"
                value={filterType}
                onChange={setFilterType}
                clearable
                data={[
                  { value: "scan_qr", label: JOB_TYPE_LABEL.scan_qr },
                  {
                    value: "get_rival_hash",
                    label: JOB_TYPE_LABEL.get_rival_hash,
                  },
                  { value: "add_rival", label: JOB_TYPE_LABEL.add_rival },
                ]}
                w={130}
              />
              <Select
                size="xs"
                placeholder="状态"
                value={filterStatus}
                onChange={setFilterStatus}
                clearable
                data={[
                  { value: "queued", label: "queued" },
                  { value: "processing", label: "processing" },
                  { value: "completed", label: "completed" },
                  { value: "failed", label: "failed" },
                ]}
                w={130}
              />
              <TextInput
                size="xs"
                placeholder="tag 包含..."
                value={filterTag}
                onChange={(e) => setFilterTag(e.currentTarget.value)}
                w={180}
              />
              <Button
                size="xs"
                variant="light"
                leftSection={<IconRefresh size={12} />}
                loading={jobsLoading}
                onClick={loadJobs}
              >
                刷新
              </Button>
            </Group>
          </Group>
          <ScrollArea>
            <Table withTableBorder withColumnBorders striped fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>类型</Table.Th>
                  <Table.Th>tag</Table.Th>
                  <Table.Th>payload</Table.Th>
                  <Table.Th>result/error</Table.Th>
                  <Table.Th>耗时</Table.Th>
                  <Table.Th>距今</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobsList?.items.map((job) => (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Badge
                        color={STATUS_COLOR[job.status]}
                        variant="light"
                        size="sm"
                      >
                        {job.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{JOB_TYPE_LABEL[job.jobType]}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {job.requesterTag ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text
                        size="xs"
                        style={{ fontFamily: "monospace" }}
                      >
                        {payloadSummary(job)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text
                        size="xs"
                        c={job.status === "failed" ? "red" : undefined}
                        style={{ fontFamily: "monospace" }}
                      >
                        {resultSummary(job)}
                      </Text>
                    </Table.Td>
                    <Table.Td>{fmtDuration(job.durationMs)}</Table.Td>
                    <Table.Td>{fmtAge(job.ageSeconds)}</Table.Td>
                  </Table.Tr>
                ))}
                {jobsList && jobsList.items.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
                      <Text size="sm" c="dimmed" ta="center">
                        暂无符合条件的任务
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </ScrollArea>
          {totalJobsPages > 1 && (
            <Group justify="center" mt="xs">
              <Pagination
                size="sm"
                total={totalJobsPages}
                value={jobsPage}
                onChange={setJobsPage}
              />
            </Group>
          )}
        </Stack>
      </Card>

      <Card withBorder padding="md" radius="md">
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Text fw={600} size="sm">
              开启了自动更新的用户
              {autoUsers && (
                <Text component="span" size="xs" c="dimmed" ml={6}>
                  共 {autoUsers.length} 人
                </Text>
              )}
            </Text>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={12} />}
              loading={autoUsersLoading}
              onClick={loadAutoUsers}
            >
              刷新
            </Button>
          </Group>
          <ScrollArea>
            <Table withTableBorder withColumnBorders striped fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>friendCode</Table.Th>
                  <Table.Th>cabinetUserId</Table.Th>
                  <Table.Th>lastScoreHash</Table.Th>
                  <Table.Th>最近一次 hash 检查</Table.Th>
                  <Table.Th>最近一次更新 job</Table.Th>
                  <Table.Th>操作</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {autoUsers?.map((u) => (
                  <Table.Tr key={u.friendCode}>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {u.friendCode}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {u.cabinetUserId ?? "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace" c="dimmed">
                        {u.lastScoreHash
                          ? u.lastScoreHash.slice(0, 8) + "…"
                          : "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {u.lastHashJob ? (
                        <Stack gap={0}>
                          <Group gap={6}>
                            <Badge
                              color={
                                STATUS_COLOR[
                                  u.lastHashJob.status as SdgbRecentJob["status"]
                                ] ?? "gray"
                              }
                              variant="light"
                              size="xs"
                            >
                              {u.lastHashJob.status}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {fmtAge(
                                Math.round(
                                  (Date.now() -
                                    new Date(u.lastHashJob.createdAt).getTime()) /
                                    1000,
                                ),
                              )}{" "}
                              前
                            </Text>
                          </Group>
                          {u.lastHashJob.error && (
                            <Text size="xs" c="red">
                              {u.lastHashJob.error.slice(0, 60)}
                            </Text>
                          )}
                        </Stack>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {u.lastIdleJob ? (
                        <Stack gap={0}>
                          <Group gap={6}>
                            <Badge
                              color={
                                u.lastIdleJob.status === "completed"
                                  ? "green"
                                  : u.lastIdleJob.status === "failed"
                                    ? "red"
                                    : u.lastIdleJob.status === "processing"
                                      ? "blue"
                                      : "gray"
                              }
                              variant="light"
                              size="xs"
                            >
                              {u.lastIdleJob.status}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              bot=
                              {u.lastIdleJob.botUserFriendCode ?? "-"}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {fmtAge(
                                Math.round(
                                  (Date.now() -
                                    new Date(u.lastIdleJob.createdAt).getTime()) /
                                    1000,
                                ),
                              )}{" "}
                              前
                            </Text>
                          </Group>
                          {u.lastIdleJob.error && (
                            <Text size="xs" c="red">
                              {u.lastIdleJob.error.slice(0, 60)}
                            </Text>
                          )}
                        </Stack>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconBolt size={12} />}
                        onClick={() => {
                          setTriggerFc(u.friendCode);
                          // Don't auto-fire — admin still has to confirm by
                          // clicking the trigger button above. Just pre-fill.
                        }}
                      >
                        填入触发框
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {autoUsers && autoUsers.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Text size="sm" c="dimmed" ta="center">
                        暂无开启自动更新的用户
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Stack>
      </Card>
    </Stack>
  );
}
