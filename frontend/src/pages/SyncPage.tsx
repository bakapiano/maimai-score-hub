import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Progress,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { IconCloudUpload, IconLogin, IconRefresh } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useState } from "react";
import type { JobResponse as JobStatus } from "@maimai-score-hub/shared";

import { syncApi, usersApi } from "../api/appClient";
import {
  createJob,
  getActiveJobByFriendCode,
  getJobById,
  verifyJob,
} from "../api/jobClient";
import { ProfileCard, type UserProfile } from "../components/ProfileCard";
import { CabinetBindingCard } from "../components/CabinetBindingCard";
import { formatFriendRequestSentAt } from "../utils/formatDate";
import { useAuth } from "../providers/AuthProvider";
import { useNavigate } from "react-router-dom";

type UserProfileResponse = {
  friendCode: string;
  hasDivingFishImportToken?: boolean;
  hasLxnsImportToken?: boolean;
  autoExportDivingFish?: boolean;
  autoExportLxns?: boolean;
  profile: UserProfile | null;
  hasCabinetUserId?: boolean;
  autoUpdate?: boolean;
  lastScoreHash?: string | null;
};

type LastSyncInfo = {
  id: string;
  createdAt: string;
  updatedAt: string;
  scores: unknown[];
  autoExportResult?: {
    divingFish?: { status: string; message?: string } | null;
    lxns?: { status: string; message?: string } | null;
  } | null;
};

const DIFFICULTY_NAMES: Record<number, string> = {
  0: "BASIC",
  1: "ADVANCED",
  2: "EXPERT",
  3: "MASTER",
  4: "Re:MASTER",
  10: "宴会场",
};

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const path = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const authorization =
    headers.get("Authorization") ?? headers.get("authorization") ?? "";

  if (path === "/api/v1/me" && method === "GET" && authorization) {
    const res = await usersApi.profile({
      headers: { authorization },
    });
    return {
      ok: res.status === 200,
      status: res.status,
      data: (res.body ?? null) as T,
    };
  }

  if (path === "/api/v1/me" && method === "PATCH" && authorization) {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const patchBody: Record<string, string | boolean | null> = {};
    if ("divingFishImportToken" in body)
      patchBody.divingFishImportToken =
        (body.divingFishImportToken as string | null) ?? null;
    if ("lxnsImportToken" in body)
      patchBody.lxnsImportToken =
        (body.lxnsImportToken as string | null) ?? null;
    if ("autoExportDivingFish" in body)
      patchBody.autoExportDivingFish = !!body.autoExportDivingFish;
    if ("autoExportLxns" in body)
      patchBody.autoExportLxns = !!body.autoExportLxns;
    const res = await usersApi.updateProfile({
      headers: { authorization },
      body: patchBody,
    });
    return {
      ok: res.status === 200,
      status: res.status,
      data: (res.body ?? null) as T,
    };
  }

  if (
    path === "/api/v1/me/prober-tokens/diving-fish" &&
    method === "POST" &&
    authorization
  ) {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as {
          username: string;
          password: string;
        })
      : { username: "", password: "" };
    const res = await usersApi.getDivingFishToken({
      headers: { authorization },
      body,
    });
    return {
      ok: res.status === 201,
      status: res.status,
      data: (res.body ?? null) as T,
    };
  }

  if (path === "/api/v1/me/sync/latest" && method === "GET" && authorization) {
    const res = await syncApi.latest({
      headers: { authorization },
    });
    return {
      ok: res.status === 200,
      status: res.status,
      data: (res.body ?? null) as T,
    };
  }

  if (
    path === "/api/v1/me/sync/latest/exports/diving-fish" &&
    method === "POST" &&
    authorization
  ) {
    const res = await syncApi.exportToDivingFish({
      headers: { authorization },
    });
    return {
      ok: res.status === 201,
      status: res.status,
      data: (res.body ?? null) as T,
    };
  }

  if (
    path === "/api/v1/me/sync/latest/exports/lxns" &&
    method === "POST" &&
    authorization
  ) {
    const res = await syncApi.exportToLxns({
      headers: { authorization },
    });
    return {
      ok: res.status === 201,
      status: res.status,
      data: (res.body ?? null) as T,
    };
  }

  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { ok: res.ok, status: res.status, data };
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Section heading used at the top level of SyncPage. Keeps the visual
 * rhythm consistent across "同步成绩 / 神秘二维码绑定 /
 * 更新查分器" without each section reinventing its own title row.
 */
function SectionHeader({
  icon,
  color,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <Group gap="sm" align="center" mb={4}>
      <Box
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `var(--mantine-color-${color}-light)`,
          color: `var(--mantine-color-${color}-filled)`,
        }}
      >
        {icon}
      </Box>
      <Stack gap={0}>
        <Text fw={700} size="lg" style={{ lineHeight: 1.2 }}>
          {title}
        </Text>
        {subtitle && (
          <Text size="xs" c="dimmed">
            {subtitle}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

export default function SyncPage() {
  const { token, offline, setOffline } = useAuth();
  const navigate = useNavigate();

  // Profile state
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Last sync info
  const [lastSync, setLastSync] = useState<LastSyncInfo | null>(null);

  // Token settings
  const [divingFishToken, setDivingFishToken] = useState("");
  const [lxnsToken, setLxnsToken] = useState("");
  const [editingDivingFishToken, setEditingDivingFishToken] = useState(false);
  const [editingLxnsToken, setEditingLxnsToken] = useState(false);

  // Diving-Fish login mode: "token" or "login"
  const [divingFishMode, setDivingFishMode] = useState<"token" | "login">(
    "token",
  );
  // Diving-Fish login credentials (not saved, only used to fetch token)
  const [divingFishUsername, setDivingFishUsername] = useState("");
  const [divingFishPassword, setDivingFishPassword] = useState("");
  const [fetchingDivingFishToken, setFetchingDivingFishToken] = useState(false);

  // Sync job state
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<JobStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);

  const totalWaitSeconds = 5 * 60;
  const remainingPercent = Math.min(
    100,
    Math.max(0, (timeLeft / totalWaitSeconds) * 100),
  );

  // Export state
  const [exportLoading, setExportLoading] = useState<
    "diving-fish" | "lxns" | null
  >(null);

  // Loading state
  const [loading, setLoading] = useState(true);

  // Fetch last sync info
  const loadLastSync = useCallback(async () => {
    if (!token) return;

    const res = await fetchJson<LastSyncInfo>("/api/v1/me/sync/latest", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok && res.data) {
      setLastSync(res.data);
    } else {
      // No sync found is normal, just don't set lastSync
      setLastSync(null);
    }
  }, [token]);

  // Fetch profile
  const loadProfile = useCallback(async () => {
    if (!token) return;

    setProfileError(null);

    const res = await fetchJson<UserProfileResponse>("/api/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok && res.data) {
      setProfile(res.data);
    } else {
      setProfileError(`加载失败 (HTTP ${res.status})`);
    }
  }, [token]);

  // Load profile and last sync on mount
  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    const doLoad = async () => {
      setLoading(true);
      setProfileError(null);

      // Kick off all independent requests in parallel.
      // Profile is needed for friendCode → active job lookup, but
      // /api/v1/me/sync/latest has no data dependency on profile and
      // were previously waiting in series — total wall time was the
      // sum of all requests. Now profile + the other requests race;
      // active-job lookup chains off profile (still serial there,
      // but unavoidable since it needs friendCode).
      const profilePromise = fetchJson<UserProfileResponse>("/api/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const syncPromise = fetchJson<LastSyncInfo>("/api/v1/me/sync/latest", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const res = await profilePromise;
      if (cancelled) return;

      if (res.ok && res.data) {
        setProfile(res.data);

        // Active-job lookup needs friendCode, so it chains off profile.
        if (res.data.friendCode) {
          const activeJobRes = await getActiveJobByFriendCode(
            res.data.friendCode,
            token,
          );
          if (cancelled) return;

          if (activeJobRes.job) {
            const activeJob = activeJobRes.job;
            setSyncJobId(activeJob.id);
            setSyncStatus(activeJob);
            if (
              activeJob.status === "queued" ||
              activeJob.status === "processing"
            ) {
              setSyncing(true);
            }
          }
        }
      } else {
        setProfileError(`加载失败 (HTTP ${res.status})`);
      }

      const syncRes = await syncPromise;
      if (cancelled) return;
      if (syncRes.ok && syncRes.data) {
        setLastSync(syncRes.data);
      }

      setLoading(false);
    };

    doLoad();

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Save tokens (silent, returns success)
  // Only sends token fields that the user has actually entered a value for
  const saveTokens = async (): Promise<boolean> => {
    if (!token) return false;

    const body: Record<string, string | null> = {};
    if (divingFishToken) body.divingFishImportToken = divingFishToken;
    if (lxnsToken) body.lxnsImportToken = lxnsToken;

    // Nothing to save
    if (Object.keys(body).length === 0) return true;

    const res = await fetchJson<unknown>("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      loadProfile();
      return true;
    }
    return false;
  };

  // Toggle auto-export settings
  const toggleAutoExport = async (
    field: "autoExportDivingFish" | "autoExportLxns",
    value: boolean,
  ) => {
    if (!token) return;
    const res = await fetchJson<unknown>("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ [field]: value }),
    });
    if (res.ok) {
      loadProfile();
    } else {
      notifications.show({
        title: "保存失败",
        message: "无法更新自动导出设置",
        color: "red",
      });
    }
  };

  // Poll job status
  useEffect(() => {
    if (!syncJobId || !syncing || !token) return;

    const interval = setInterval(async () => {
      try {
        const job = await getJobById(syncJobId, token);
        setSyncStatus(job);

        if (
          job.status === "completed" ||
          job.status === "failed" ||
          job.status === "canceled"
        ) {
          setSyncing(false);
          if (job.status === "completed") {
            loadProfile();
            loadLastSync();

            // Re-fetch job after a delay to pick up auto-export results
            setTimeout(async () => {
              try {
                const updated = await getJobById(syncJobId, token);
                setSyncStatus(updated);
              } catch {
                // ignore
              }
            }, 3000);
          }
        }
      } catch {
        setSyncError("轮询失败");
        return;
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [syncJobId, syncing, token, loadProfile, loadLastSync]);

  // Handle timeout countdown for wait_acceptance stage
  useEffect(() => {
    if (
      !syncStatus ||
      syncStatus.stage !== "wait_acceptance" ||
      !syncStatus.friendRequestSentAt
    ) {
      if (timeLeft !== 0) setTimeLeft(0);
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const sentAt = new Date(syncStatus.friendRequestSentAt!).getTime();
      const end = sentAt + totalWaitSeconds * 1000;
      const left = Math.max(0, Math.ceil((end - now) / 1000));
      setTimeLeft(left);
    }, 500);

    return () => clearInterval(interval);
  }, [syncStatus?.stage, syncStatus?.friendRequestSentAt]);

  // Start sync
  const startSync = async () => {
    if (!profile?.friendCode) return;

    setSyncing(true);
    setSyncError(null);
    setSyncStatus(null);

    try {
      const res = await createJob(
        {
          skipUpdateScore: false,
        },
        token!,
      );

      setSyncJobId(res.jobId);
      setSyncStatus(res.job);
    } catch (error) {
      setSyncing(false);
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      setSyncError(`创建同步任务失败: ${errorMessage}`);
    }
  };

  const verifySyncJob = async () => {
    if (!syncJobId || !token) return;

    setVerifyLoading(true);
    try {
      const res = await verifyJob(syncJobId, token);
      setSyncStatus(res.job);
      setSyncing(true);
      notifications.show({
        title: "已提交验证",
        message: "后台将立即重新检查好友状态",
        color: "green",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      notifications.show({
        title: "提交失败",
        message,
        color: "red",
      });
    } finally {
      setVerifyLoading(false);
    }
  };

  // Export to diving-fish
  const exportToDivingFish = async () => {
    if (!token) return;

    setExportLoading("diving-fish");

    // Save token first
    await saveTokens();

    const res = await fetchJson<{
      success?: boolean;
      message?: string;
      scores?: number;
      exported?: number;
      response?: { creates?: number; updates?: number; message?: string };
    }>("/api/v1/me/sync/latest/exports/diving-fish", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    setExportLoading(null);

    if (res.ok) {
      const scores = res.data?.scores;
      const creates = res.data?.response?.creates ?? 0;
      const updates = res.data?.response?.updates ?? 0;
      notifications.show({
        title: "导出成功",
        message: `成绩已导出到 Diving-Fish（共 ${scores ?? "?"} 条成绩，新增 ${creates} 条，更新 ${updates} 条）`,
        color: "green",
      });
    } else {
      const data = res.data as { message?: string } | null;
      notifications.show({
        title: "导出失败",
        message:
          (data?.message || `HTTP ${res.status}`) + " 请检查 Token 是否正确！",
        color: "red",
      });
    }
  };

  // Export to LXNS
  const exportToLxns = async () => {
    if (!token) return;

    setExportLoading("lxns");

    // Save token first
    await saveTokens();

    const res = await fetchJson<{
      success?: boolean;
      message?: string;
      scores?: number;
      exported?: number;
      response?: { success?: boolean; code?: number; data?: unknown[] };
    }>("/api/v1/me/sync/latest/exports/lxns", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    setExportLoading(null);

    if (res.ok) {
      const scores = res.data?.scores;
      const dataCount = Array.isArray(res.data?.response?.data)
        ? res.data?.response?.data.length
        : undefined;
      const exported = res.data?.exported;
      const count = dataCount ?? exported;
      notifications.show({
        title: "导出成功",
        message:
          count !== undefined
            ? `成绩已导出到 落雪查分器（共 ${scores ?? "?"} 条成绩，导出 ${count} 条）`
            : "成绩已导出到 落雪查分器",
        color: "green",
      });
    } else {
      const data = res.data as { message?: string } | null;
      notifications.show({
        title: "导出失败",
        message:
          (data?.message || `HTTP ${res.status}`) + " 请检查 Token 是否正确！",
        color: "red",
      });
    }
  };

  // Compute sync progress
  const getSyncProgress = () => {
    if (!syncStatus?.scoreProgress) return null;
    const { completedDiffs, totalDiffs } = syncStatus.scoreProgress;
    const percent =
      totalDiffs > 0 ? (completedDiffs.length / totalDiffs) * 100 : 0;
    return { completedDiffs, totalDiffs, percent };
  };

  const progress = getSyncProgress();

  return (
    <Box style={{ position: "relative" }}>
      {offline && (
        <Box
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
            paddingTop: 48,
            gap: 12,
            backdropFilter: "blur(4px)",
            backgroundColor: "rgba(255, 255, 255, 0.3)",
            borderRadius: 8,
            zIndex: 10,
          }}
        >
          <Text fw={600} size="lg">
            需要登录
          </Text>
          <Text size="sm" c="dimmed">
            同步数据功能需要登录后才能使用
          </Text>
          <Button
            leftSection={<IconLogin size={16} />}
            onClick={() => {
              setOffline(false);
              navigate("/login", { replace: true });
            }}
          >
            前往登录
          </Button>
        </Box>
      )}
      <Stack gap="xl" mx="auto" w="100%">
        {/* Profile Section */}

        {profileError && <Alert color="red">{profileError}</Alert>}

        {loading && !profile?.profile && (
          <Card withBorder padding="md" radius="md" h={160}>
            <Group justify="center" py="md" h={160}>
              <Loader size="sm" />
            </Group>
          </Card>
        )}

        {profile?.profile && <ProfileCard profile={profile.profile} />}

        {/* Sync Section */}
        <Stack gap="md">
          <SectionHeader
            icon={<IconCloudUpload size={18} />}
            color="blue"
            title="同步成绩"
            subtitle="从 maimai DX NET 拉取最新游戏成绩"
          />

          {lastSync && (
            <Card withBorder padding="sm" radius="md">
              <Group justify="space-between" align="center">
                <Group gap="xl">
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">
                      上次同步
                    </Text>
                    <Text size="sm" fw={500}>
                      {formatDate(lastSync.createdAt)}
                    </Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">
                      记录条数
                    </Text>
                    <Badge variant="light" size="lg" radius="md">
                      {lastSync.scores.length} 条
                    </Badge>
                  </Stack>
                  {lastSync.autoExportResult && (
                    <Stack gap={2}>
                      <Text size="xs" c="dimmed">
                        自动导出
                      </Text>
                      <Group gap={4}>
                        {lastSync.autoExportResult.divingFish && (
                          <Badge
                            variant="light"
                            size="lg"
                            radius="md"
                            color={
                              lastSync.autoExportResult.divingFish.status ===
                              "success"
                                ? "green"
                                : "red"
                            }
                          >
                            水鱼{" "}
                            {lastSync.autoExportResult.divingFish.status ===
                            "success"
                              ? "✓"
                              : "✗"}
                          </Badge>
                        )}
                        {lastSync.autoExportResult.lxns && (
                          <Badge
                            variant="light"
                            size="lg"
                            radius="md"
                            color={
                              lastSync.autoExportResult.lxns.status ===
                              "success"
                                ? "green"
                                : "red"
                            }
                          >
                            落雪{" "}
                            {lastSync.autoExportResult.lxns.status === "success"
                              ? "✓"
                              : "✗"}
                          </Badge>
                        )}
                      </Group>
                    </Stack>
                  )}
                </Group>
                <Group gap="sm">
                  <Button
                    onClick={startSync}
                    disabled={!profile?.friendCode || syncing}
                    variant="light"
                    size="sm"
                  >
                    更新数据
                  </Button>
                </Group>
              </Group>
              {syncing && syncStatus && (
                <Group gap="xs" mt={4}>
                  <Loader size="xs" />
                  <Text size="xs" c="dimmed">
                    {syncStatus.status === "queued"
                      ? "正在排队中，请稍候..."
                      : syncStatus.stage === "send_request"
                        ? "正在发送好友请求，通常需要等待约 60 秒..."
                        : syncStatus.stage === "update_score"
                          ? "正在更新成绩..."
                          : "同步中..."}
                  </Text>
                </Group>
              )}
            </Card>
          )}

          {loading && (
            <Card withBorder padding="md" radius="md">
              <Stack gap="sm" align="center">
                <Loader size="sm" />
                <Text size="sm" c="dimmed">
                  加载中...
                </Text>
              </Stack>
            </Card>
          )}

          {!loading && !lastSync && !syncStatus && (
            <Card withBorder padding="md" radius="md">
              <Stack gap="sm" align="center">
                <Text size="sm" c="dimmed" ta="center">
                  暂无同步记录，点击下方按钮开始首次同步。
                </Text>
                <Button
                  onClick={startSync}
                  disabled={!profile?.friendCode || syncing}
                  variant="filled"
                >
                  开始同步
                </Button>
              </Stack>
            </Card>
          )}

          {syncError && <Alert color="red">{syncError}</Alert>}

          {syncStatus && (
            <Card
              withBorder
              padding="md"
              radius="md"
              style={{
                borderLeft:
                  syncStatus.status === "completed"
                    ? "4px solid var(--mantine-color-green-6)"
                    : syncStatus.status === "failed" ||
                        syncStatus.status === "canceled"
                      ? "4px solid var(--mantine-color-red-6)"
                      : syncStatus.status === "processing"
                        ? "4px solid var(--mantine-color-blue-6)"
                        : "4px solid var(--mantine-color-gray-4)",
              }}
            >
              <Stack gap="sm">
                <Group justify="space-between" align="center">
                  <Group gap="xs">
                    <Text size="sm" fw={500} c="dimmed">
                      状态
                    </Text>
                  </Group>
                  <Badge
                    size="lg"
                    radius="sm"
                    variant="light"
                    color={
                      syncStatus.status === "completed"
                        ? "green"
                        : syncStatus.status === "failed" ||
                            syncStatus.status === "canceled"
                          ? "red"
                          : syncStatus.status === "queued"
                            ? "gray"
                            : "blue"
                    }
                  >
                    {syncStatus.status === "completed"
                      ? "✓ 已完成"
                      : syncStatus.status === "failed"
                        ? "✗ 失败"
                        : syncStatus.status === "canceled"
                          ? "已取消"
                          : syncStatus.status === "queued"
                            ? "排队中"
                            : "● 进行中"}
                  </Badge>
                </Group>

                {/* <Group justify="space-between" align="center">
                <Text size="sm" fw={500} c="dimmed">
                  当前阶段
                </Text>
                <Text size="sm" fw={500}>
                  {getStageLabel(syncStatus.stage)}
                </Text>
              </Group> */}

                {syncStatus.error && (
                  <Alert color="red" variant="light" title="错误" radius="md">
                    {syncStatus.error}
                  </Alert>
                )}

                {progress && syncStatus.stage === "update_score" && (
                  <Stack gap="xs">
                    <Divider />
                    <Group justify="space-between" align="center">
                      <Text size="sm" fw={500} c="dimmed">
                        更新进度
                      </Text>
                      <Text size="sm" fw={600}>
                        {progress.completedDiffs.length} / {progress.totalDiffs}
                      </Text>
                    </Group>
                    <Progress
                      value={progress.percent}
                      animated={syncing}
                      size="md"
                      radius="xl"
                      color={progress.percent === 100 ? "green" : "blue"}
                    />
                    {progress.completedDiffs.length > 0 && (
                      <Group gap="xs" mt={4}>
                        {progress.completedDiffs.map((diff) => (
                          <Badge
                            radius={"md"}
                            key={diff}
                            size="sm"
                            variant="filled"
                            color={
                              diff === 0
                                ? "green"
                                : diff === 1
                                  ? "yellow"
                                  : diff === 2
                                    ? "red"
                                    : diff === 3
                                      ? "grape"
                                      : diff === 4
                                        ? "violet"
                                        : "pink"
                            }
                          >
                            {DIFFICULTY_NAMES[diff] ?? `Diff ${diff}`}
                          </Badge>
                        ))}
                      </Group>
                    )}
                  </Stack>
                )}

                {syncing && syncStatus.stage === "wait_acceptance" && (
                  <Alert
                    variant="outline"
                    radius="md"
                    color="blue"
                    title="好友请求已发送！"
                  >
                    <Stack gap="sm">
                      <Text size="sm">
                        Bot 已发送好友申请，请登录 NET
                        并在核对时间一致后同意好友申请。
                      </Text>
                      {syncStatus.friendRequestSentAt && (
                        <Text size="sm" c="red" fw={700}>
                          若申请时间不是{" "}
                          {formatFriendRequestSentAt(
                            syncStatus.friendRequestSentAt,
                          )}
                          ，请勿接受，可能是他人尝试登录！
                        </Text>
                      )}
                      <Progress.Root size="xl" mt={4}>
                        <Progress.Section
                          animated
                          value={remainingPercent}
                          title={`${timeLeft} 秒后过期`}
                        >
                          <Progress.Label>{timeLeft} 秒后过期</Progress.Label>
                        </Progress.Section>
                      </Progress.Root>
                      <Button
                        onClick={verifySyncJob}
                        loading={verifyLoading}
                        disabled={!syncJobId}
                      >
                        我已接受请求
                      </Button>
                    </Stack>
                  </Alert>
                )}

                {/* Auto-export results */}
                {syncStatus.status === "completed" &&
                  syncStatus.autoExportResult && (
                    <Stack gap="xs">
                      <Divider />
                      <Text size="sm" fw={500} c="dimmed">
                        自动导出结果
                      </Text>
                      {syncStatus.autoExportResult.divingFish && (
                        <Group gap="xs">
                          <Text size="sm">水鱼查分器：</Text>
                          <Badge
                            variant="light"
                            size="sm"
                            color={
                              syncStatus.autoExportResult.divingFish.status ===
                              "success"
                                ? "green"
                                : "red"
                            }
                          >
                            {syncStatus.autoExportResult.divingFish.status ===
                            "success"
                              ? "✓ 成功"
                              : "✗ 失败"}
                          </Badge>
                          {syncStatus.autoExportResult.divingFish.message && (
                            <Text size="xs" c="dimmed">
                              {syncStatus.autoExportResult.divingFish.message}
                            </Text>
                          )}
                        </Group>
                      )}
                      {syncStatus.autoExportResult.lxns && (
                        <Group gap="xs">
                          <Text size="sm">落雪查分器：</Text>
                          <Badge
                            variant="light"
                            size="sm"
                            color={
                              syncStatus.autoExportResult.lxns.status ===
                              "success"
                                ? "green"
                                : "red"
                            }
                          >
                            {syncStatus.autoExportResult.lxns.status ===
                            "success"
                              ? "✓ 成功"
                              : "✗ 失败"}
                          </Badge>
                          {syncStatus.autoExportResult.lxns.message && (
                            <Text size="xs" c="dimmed">
                              {syncStatus.autoExportResult.lxns.message}
                            </Text>
                          )}
                        </Group>
                      )}
                    </Stack>
                  )}
              </Stack>
            </Card>
          )}
        </Stack>

        {/* Cabinet QR Section */}
        {token && profile && (
          <Stack gap="md">
            <SectionHeader
              icon={<IconRefresh size={18} />}
              color="grape"
              title="神秘二维码绑定"
              subtitle="绑定后可在推分时自动同步成绩"
            />
            <CabinetBindingCard
              token={token}
              hasCabinetUserId={profile.hasCabinetUserId ?? false}
              autoUpdate={profile.autoUpdate ?? false}
              onChanged={() => {
                void loadProfile();
              }}
            />
          </Stack>
        )}
        {/* Token Settings & Export Section */}
        <Stack gap="md">
          <SectionHeader
            icon={<IconCloudUpload size={18} />}
            color="teal"
            title="更新查分器"
            subtitle="将成绩自动导出到水鱼 / 落雪查分器"
          />

          <Card withBorder padding="md" radius="md">
            <Stack gap="md">
              <Switch
                label="同步后自动更新水鱼查分器"
                description={
                  !profile?.hasDivingFishImportToken
                    ? "请先配置水鱼 Import Token"
                    : undefined
                }
                checked={profile?.autoExportDivingFish ?? false}
                disabled={!profile?.hasDivingFishImportToken}
                onChange={(e) =>
                  toggleAutoExport(
                    "autoExportDivingFish",
                    e.currentTarget.checked,
                  )
                }
              />
              <Switch
                label="同步后自动更新落雪查分器"
                description={
                  !profile?.hasLxnsImportToken
                    ? "请先配置落雪 Personal Token"
                    : undefined
                }
                checked={profile?.autoExportLxns ?? false}
                disabled={!profile?.hasLxnsImportToken}
                onChange={(e) =>
                  toggleAutoExport("autoExportLxns", e.currentTarget.checked)
                }
              />
            </Stack>
          </Card>

          {/* Diving-Fish Section */}
          <Card withBorder padding="md" radius="md">
            <Stack gap="md">
              <Anchor
                href="https://www.diving-fish.com/maimaidx/prober/"
                target="_blank"
                fw={500}
                size="sm"
              >
                水鱼查分器
              </Anchor>

              <Tabs
                value={divingFishMode}
                onChange={(v) =>
                  setDivingFishMode((v as "token" | "login") ?? "token")
                }
              >
                <Tabs.List>
                  <Tabs.Tab value="token">Token</Tabs.Tab>
                  <Tabs.Tab value="login">账号密码</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="token" pt="md">
                  <Group align="flex-end" gap="xs">
                    <PasswordInput
                      label="Import Token"
                      placeholder="输入 import token"
                      value={
                        profile?.hasDivingFishImportToken &&
                        !editingDivingFishToken
                          ? "••••••••••••••••••••••••••••••••"
                          : divingFishToken
                      }
                      disabled={
                        !!profile?.hasDivingFishImportToken &&
                        !editingDivingFishToken
                      }
                      onChange={(e) => setDivingFishToken(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    {profile?.hasDivingFishImportToken &&
                    !editingDivingFishToken ? (
                      <Button
                        onClick={() => {
                          setEditingDivingFishToken(true);
                          setDivingFishToken("");
                        }}
                        variant="subtle"
                        size="sm"
                      >
                        修改
                      </Button>
                    ) : null}
                    <Button
                      onClick={exportToDivingFish}
                      loading={exportLoading === "diving-fish"}
                      disabled={
                        (!divingFishToken &&
                          !profile?.hasDivingFishImportToken) ||
                        (editingDivingFishToken && !divingFishToken) ||
                        exportLoading !== null
                      }
                      variant="light"
                      size="sm"
                    >
                      {exportLoading === "diving-fish" ? (
                        <Loader size="xs" />
                      ) : (
                        "更新"
                      )}
                    </Button>
                  </Group>
                </Tabs.Panel>

                <Tabs.Panel value="login" pt="md">
                  <Stack gap="sm">
                    <Text size="xs" c="red">
                      账号密码仅用于获取成绩导入
                      token，不会保存在服务器或浏览器中
                    </Text>
                    <TextInput
                      label="用户名"
                      placeholder="水鱼账号用户名"
                      value={divingFishUsername}
                      onChange={(e) => setDivingFishUsername(e.target.value)}
                    />
                    <PasswordInput
                      label="密码"
                      placeholder="水鱼账号密码"
                      value={divingFishPassword}
                      onChange={(e) => setDivingFishPassword(e.target.value)}
                    />
                    <Button
                      onClick={async () => {
                        if (!divingFishUsername || !divingFishPassword) {
                          notifications.show({
                            title: "错误",
                            message: "请填写用户名和密码",
                            color: "red",
                          });
                          return;
                        }

                        setFetchingDivingFishToken(true);
                        try {
                          // Step 1: Get token
                          const res = await fetchJson<{
                            importToken?: string;
                            nickname?: string;
                            message?: string;
                          }>("/api/v1/me/prober-tokens/diving-fish", {
                            method: "POST",
                            headers: {
                              Authorization: `Bearer ${token}`,
                              "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                              username: divingFishUsername,
                              password: divingFishPassword,
                            }),
                          });

                          if (res.ok && res.data?.importToken) {
                            const fetchedToken = res.data.importToken;
                            setDivingFishToken(fetchedToken);
                            // Clear credentials after successful fetch
                            setDivingFishUsername("");
                            setDivingFishPassword("");

                            // Step 2: Save token and export
                            const saveRes = await fetchJson<unknown>(
                              "/api/v1/me",
                              {
                                method: "PATCH",
                                headers: {
                                  Authorization: `Bearer ${token}`,
                                  "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                  divingFishImportToken: fetchedToken,
                                  lxnsImportToken: lxnsToken || null,
                                }),
                              },
                            );

                            if (saveRes.ok) {
                              // Step 3: Export to diving-fish
                              const exportRes = await fetchJson<{
                                success?: boolean;
                                message?: string;
                                exported?: number;
                                response?: {
                                  creates?: number;
                                  updates?: number;
                                  message?: string;
                                };
                              }>("/api/v1/me/sync/latest/exports/diving-fish", {
                                method: "POST",
                                headers: {
                                  Authorization: `Bearer ${token}`,
                                  "Content-Type": "application/json",
                                },
                              });

                              if (exportRes.ok) {
                                const creates =
                                  exportRes.data?.response?.creates ?? 0;
                                const updates =
                                  exportRes.data?.response?.updates ?? 0;
                                notifications.show({
                                  title: "更新成功",
                                  message: `成绩已导出到 Diving-Fish（新增 ${creates} 条，更新 ${updates} 条）`,
                                  color: "green",
                                });
                                // Switch to token mode
                                setDivingFishMode("token");
                              } else {
                                const data = exportRes.data as {
                                  message?: string;
                                } | null;
                                notifications.show({
                                  title: "导出失败",
                                  message:
                                    (data?.message ||
                                      `HTTP ${exportRes.status}`) +
                                    " 请检查 Token 是否正确！",
                                  color: "red",
                                });
                              }
                            } else {
                              notifications.show({
                                title: "获取成功，但保存失败",
                                message: res.data.nickname
                                  ? `已获取 ${res.data.nickname} 的 Import Token，但保存失败`
                                  : "已成功获取 Import Token，但保存失败",
                                color: "yellow",
                              });
                            }
                          } else {
                            const errorMsg =
                              res.data?.message || `HTTP ${res.status}`;
                            notifications.show({
                              title: "获取失败",
                              message: errorMsg,
                              color: "red",
                            });
                          }
                        } catch {
                          notifications.show({
                            title: "操作失败",
                            message: "网络错误，请稍后重试",
                            color: "red",
                          });
                        } finally {
                          setFetchingDivingFishToken(false);
                        }
                      }}
                      loading={fetchingDivingFishToken}
                      disabled={
                        !divingFishUsername ||
                        !divingFishPassword ||
                        fetchingDivingFishToken
                      }
                      variant="filled"
                      size="sm"
                    >
                      获取 Token 并更新
                    </Button>
                  </Stack>
                </Tabs.Panel>
              </Tabs>
            </Stack>
          </Card>

          {/* LXNS Section */}
          <Card withBorder padding="md" radius="md">
            <Stack gap="md">
              <Anchor
                href="https://maimai.lxns.net/"
                target="_blank"
                fw={500}
                size="sm"
              >
                落雪查分器
              </Anchor>
              <Group align="flex-end" gap="xs">
                <PasswordInput
                  label="Personal Token"
                  placeholder="输入 personal token"
                  value={
                    profile?.hasLxnsImportToken && !editingLxnsToken
                      ? "••••••••••••••••••••••••••••••••"
                      : lxnsToken
                  }
                  disabled={!!profile?.hasLxnsImportToken && !editingLxnsToken}
                  onChange={(e) => setLxnsToken(e.target.value)}
                  style={{ flex: 1 }}
                />
                {profile?.hasLxnsImportToken && !editingLxnsToken ? (
                  <Button
                    onClick={() => {
                      setEditingLxnsToken(true);
                      setLxnsToken("");
                    }}
                    variant="subtle"
                    size="sm"
                  >
                    修改
                  </Button>
                ) : null}
                <Button
                  onClick={exportToLxns}
                  loading={exportLoading === "lxns"}
                  disabled={
                    (!lxnsToken && !profile?.hasLxnsImportToken) ||
                    (editingLxnsToken && !lxnsToken) ||
                    exportLoading !== null
                  }
                  variant="light"
                  size="sm"
                >
                  {exportLoading === "lxns" ? <Loader size="xs" /> : "更新"}
                </Button>
              </Group>
            </Stack>
          </Card>
        </Stack>
      </Stack>
    </Box>
  );
}
